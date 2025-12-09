const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

app.get("/ping", (req, res) =>
  res.json({ status: "ok", time: new Date().toISOString() })
);

/**
 * In-memory sessions store
 *
 * sessions = {
 *   [sessionId]: {
 *     id,
 *     players: Map(socketId => {id: socketId, name, score, attemptsLeft}),
 *     gm: socketId,
 *     question: string|null,
 *     answer: string|null, // stored in lowercase trimmed for checking
 *     inProgress: boolean,
 *     timer: Timeout|null,
 *     winner: socketId|null
 *   }
 * }
 */
const sessions = {};

/* Helpers */
// Helper to create a unique session ID
function makeSessionId() {
  return Math.random().toString(36).substring(2, 8);
}

// Sanitize answer for comparison
function sanitizeAnswer(a) {
  return String(a || "")
    .trim()
    .toLowerCase();
}

function broadcastSessionState(session) {
  const players = Array.from(session.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    attemptsLeft: p.attemptsLeft,
    isGM: p.id === session.gm,
  }));

  io.to(session.id).emit("session_state", {
    sessionId: session.id,
    players,
    gm: session.gm,
    inProgress: session.inProgress,
    question: session.inProgress ? session.question : null,
    winner: session.winner,
  });
}

// Example: user joins a session
function joinSession(sessionId, socket, playerName) {
  const session = sessions[sessionId];
  if (!session) return;
  // prevent joining if game in progress
  if (session.inProgress) {
    socket.emit("error_message", "Game in progress — cannot join");
    return;
  }

  session.players.set(socket.id, {
    id: socket.id,
    name: playerName,
    score: 0,
    attemptsLeft: 0,
  });

  socket.join(sessionId);
  broadcastSessionState(session);
}

// Example: user leaves a session
function leaveSessionByUser(sessionId, socket) {
  const session = sessions[sessionId];
  if (!session) return;

  const player = session.players.get(socket.id);
  const playerName = player?.name || socket.playerName || "A player";

  // Emit the "player left" message to everyone still in the room BEFORE removing the player
  console.log(
    `Server: broadcasting that ${playerName} is leaving session ${sessionId}`
  );
  io.to(sessionId).emit("system_message", `${playerName} left the session.`);

  // Now remove the player and make socket leave the room
  session.players.delete(socket.id);
  socket.leave(sessionId);
  delete socket.sessionId;
  delete socket.playerName;

  // If session has no players now, clear timer and delete it
  if (session.players.size === 0) {
    if (session.timer) clearTimeout(session.timer);
    delete sessions[sessionId];
    console.log("Session deleted:", sessionId);
    return;
  }

  // If leaving player was the GM, rotate GM to the first remaining player
  if (socket.id === session.gm) {
    const firstId = session.players.keys().next().value;
    session.gm = firstId;
    io.to(sessionId).emit(
      "system_message",
      `${session.players.get(firstId).name} is now the Game Master.`
    );
  }

  // If a player leaves during an in-progress game and less than 2 players remain -> end game
  if (session.inProgress && session.players.size < 2) {
    endGame(sessionId, "stopped_not_enough_players", null);
  } else {
    // broadcast updated state (player list & scores) to remaining players
    broadcastSessionState(session);
  }
}

function endGame(sessionId, reason, winnerSocketId = null) {
  const session = sessions[sessionId];
  if (!session) return;
  // clear timer
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  session.inProgress = false;
  session.winner = winnerSocketId;

  if (winnerSocketId) {
    // award points (10)
    const winner = session.players.get(winnerSocketId);
    if (winner) {
      winner.score = (winner.score || 0) + 10;
    }
  }

  // reveal answer to everyone (send original answer text if we kept it)
  const revealedAnswer = session.answerOriginal || session.answer || null;

  io.to(session.id).emit("game_ended", {
    reason,
    winner: winnerSocketId
      ? { id: winnerSocketId, name: session.players.get(winnerSocketId)?.name }
      : null,
    answer: revealedAnswer,
  });

  // Rotate GM: pick first player that is not the current GM (if any)
  const playerIds = Array.from(session.players.keys());
  if (playerIds.length > 0) {
    // find index of current GM in the list; choose next index (wrap) or first if GM not found
    const idx = playerIds.indexOf(session.gm);
    let nextIdx = 0;
    if (idx >= 0) nextIdx = (idx + 1) % playerIds.length;
    session.gm = playerIds[nextIdx];
  } else {
    // no players left will be handled in disconnect/leave
  }

  // reset question/answer so next GM can set a new one
  session.question = null;
  session.answer = null;
  session.answerOriginal = null;
  // reset attemptsLeft for players (they'll be set when next game starts)
  session.players.forEach((p) => {
    p.attemptsLeft = 0;
  });

  // broadcast updated state (scores, new gm)
  broadcastSessionState(session);
}

/* Socket handlers */
io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  socket.on("create_session", ({ name, sessionId }) => {
    name = (name || "Anonymous").toString().trim().slice(0, 30);
    sessionId =
      sessionId && sessionId.toString().trim()
        ? sessionId.toString().trim()
        : makeSessionId();

    if (sessions[sessionId]) {
      socket.emit(
        "error_message",
        "Session ID already exists. Try joining it or use another ID."
      );
      return;
    }

    const session = {
      id: sessionId,
      players: new Map(),
      gm: socket.id,
      question: null,
      answer: null,
      answerOriginal: null,
      inProgress: false,
      timer: null,
      winner: null,
    };

    const player = { id: socket.id, name, score: 0, attemptsLeft: 0 };
    session.players.set(socket.id, player);

    sessions[sessionId] = session;

    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.playerName = name;

    socket.emit("session_created", { sessionId, gm: session.gm });
    io.to(sessionId).emit(
      "system_message",
      `${name} created the session and is the Game Master.`
    );

    broadcastSessionState(session);
  });

  // join_session handler
  socket.on("join_session", ({ sessionId, name }) => {
    name = (name || "Anonymous").toString().trim().slice(0, 30);
    sessionId = (sessionId || "").toString().trim();
    const session = sessions[sessionId];
    if (!session) {
      socket.emit("error_message", "Session not found.");
      return;
    }
    if (session.inProgress) {
      socket.emit("error_message", "Cannot join — game already in progress.");
      return;
    }

    const player = { id: socket.id, name, score: 0, attemptsLeft: 0 };
    session.players.set(socket.id, player);

    socket.join(sessionId);

    // <<< IMPORTANT: store sessionId and playerName on socket so leave_session works
    socket.sessionId = sessionId;
    socket.playerName = name;

    io.to(sessionId).emit("system_message", `${name} joined the session.`);
    broadcastSessionState(session);
  });

  socket.on("leave_session", () => {
    const sessionId = socket.sessionId;
    console.log(
      `leave_session event from ${socket.id}, sessionId=${sessionId}`
    );
    if (!sessionId) {
      socket.emit("error_message", "You are not currently in a session.");
      return;
    }
    leaveSessionByUser(sessionId, socket);
    socket.emit("left_session", { sessionId });
  });

  socket.on("set_question", ({ question, answer }) => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit("error_message", "You are not in a session.");
      return;
    }
    const session = sessions[sessionId];
    if (!session) return;
    if (session.gm !== socket.id) {
      socket.emit(
        "error_message",
        "Only the Game Master can set the question."
      );
      return;
    }
    if (session.inProgress) {
      socket.emit(
        "error_message",
        "Cannot set question while a game is in progress."
      );
      return;
    }
    question = (question || "").toString().trim().slice(0, 500);
    answer = (answer || "").toString().trim().slice(0, 200);
    if (!question || !answer) {
      socket.emit("error_message", "Question and answer must not be empty.");
      return;
    }

    session.question = question;
    session.answerOriginal = answer;
    session.answer = sanitizeAnswer(answer);

    socket.emit("system_message", "Question set.");
    broadcastSessionState(session);
  });

  socket.on("start_game", () => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit("error_message", "You are not in a session.");
      return;
    }
    const session = sessions[sessionId];
    if (!session) return;
    if (session.gm !== socket.id) {
      socket.emit("error_message", "Only the Game Master can start the game.");
      return;
    }
    if (session.inProgress) {
      socket.emit("error_message", "Game already in progress.");
      return;
    }
    if (session.players.size < 2) {
      socket.emit(
        "error_message",
        "You need at least 2 players to start the game."
      );
      return;
    }
    if (!session.question || !session.answer) {
      socket.emit(
        "error_message",
        "Set a question and answer before starting."
      );
      return;
    }

    // initialize attempts for each player (3) and clear winner
    session.players.forEach((p) => {
      p.attemptsLeft = 3;
    });
    session.inProgress = true;
    session.winner = null;

    // Start 60s timer
    session.timer = setTimeout(() => {
      // Time expired, end game with no winner
      endGame(sessionId, "time_expired", null);
    }, 60 * 1000); // 60 seconds

    io.to(sessionId).emit("game_started", {
      question: session.question,
      duration: 60,
    });

    broadcastSessionState(session);
    io.to(sessionId).emit(
      "system_message",
      `Game started by ${session.players.get(session.gm).name}. Good luck!`
    );
  });

  socket.on("guess", ({ guessText }) => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit("error_message", "You are not in a session.");
      return;
    }
    const session = sessions[sessionId];
    if (!session || !session.inProgress) {
      socket.emit("error_message", "No active game in this session.");
      return;
    }
    const player = session.players.get(socket.id);
    if (!player) {
      socket.emit("error_message", "You are not a player in this session.");
      return;
    }
    if (player.attemptsLeft <= 0) {
      socket.emit("error_message", "No attempts left.");
      return;
    }
    // validate guess
    guessText = (guessText || "").toString().trim();
    if (!guessText) {
      socket.emit("error_message", "Guess cannot be empty.");
      return;
    }

    // decrement attempts
    player.attemptsLeft -= 1;

    io.to(sessionId).emit(
      "system_message",
      `${player.name} guessed: "${guessText}" (attempts left: ${player.attemptsLeft})`
    );
    broadcastSessionState(session);

    // check answer (case-insensitive)
    const normalizedGuess = guessText.toLowerCase().trim();
    if (normalizedGuess === session.answer) {
      // if there is already a winner (concurrent), ignore
      if (!session.winner) {
        session.winner = socket.id;
        endGame(sessionId, "correct_guess", socket.id);
      }
      return;
    }

    // if player ran out of attempts, notify
    if (player.attemptsLeft <= 0) {
      socket.emit(
        "system_message",
        "You have used all your attempts for this round."
      );
    }
  });

  socket.on("get_session_state", () => {
    const sessionId = socket.sessionId;
    if (!sessionId) return;
    const session = sessions[sessionId];
    if (!session) return;
    broadcastSessionState(session);
  });

  socket.on("disconnect", () => {
    console.log("socket disconnected", socket.id);
    const sessionId = socket.sessionId;
    if (sessionId) {
      leaveSessionOnDisconnect(socket, sessionId);
    }
  });

  // Helper to leave session (used by disconnect and leave_session)
  function leaveSessionOnDisconnect(socket, sessionId) {
    const session = sessions[sessionId];
    if (!session) return;
    const player = session.players.get(socket.id);
    const playerName = player?.name || socket.playerName || "A player";

    // remove from session
    session.players.delete(socket.id);
    socket.leave(sessionId);
    delete socket.sessionId;
    delete socket.playerName;

    io.to(sessionId).emit("system_message", `${playerName} left the session.`);

    // If session had no players now, delete session and clear timer
    if (session.players.size === 0) {
      if (session.timer) clearTimeout(session.timer);
      delete sessions[sessionId];
      console.log("Session deleted:", sessionId);
      return;
    }

    // If leaving player was the GM and game not in progress, rotate GM now
    if (socket.id === session.gm) {
      // choose first remaining player as new GM
      const firstId = session.players.keys().next().value;
      session.gm = firstId;
      io.to(sessionId).emit(
        "system_message",
        `${session.players.get(firstId).name} is now the Game Master.`
      );
    }

    // If a player leaves during an in-progress game:
    // - If player was the winner (shouldn't happen because winner ends game and game stops), handled elsewhere.
    // - If after leaving only 1 player remains, we could end the game (since at least 2 players required). We'll end it as time-expired/no winner:
    if (session.inProgress && session.players.size < 2) {
      // end game with no winner
      endGame(sessionId, "stopped_not_enough_players", null);
    } else {
      broadcastSessionState(session);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
