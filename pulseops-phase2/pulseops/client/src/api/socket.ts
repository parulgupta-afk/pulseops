import { io, type Socket } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

let socket: Socket | null = null;

// One shared socket for the app's lifetime, authenticated via the same JWT
// the REST client uses. Call connectSocket() once after login (or on app
// load if already logged in); components subscribe to events on it, they
// don't each open their own connection.
export function connectSocket(): Socket {
  if (socket) return socket;

  const token = localStorage.getItem("pulseops_token");
  socket = io(API_URL, {
    auth: { token },
  });

  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export function getSocket(): Socket | null {
  return socket;
}
