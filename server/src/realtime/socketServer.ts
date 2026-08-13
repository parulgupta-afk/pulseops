import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { verifyToken } from "../utils/jwt";
import {
  subscriber,
  INCIDENT_EVENTS_CHANNEL,
  type IncidentEventMessage,
} from "./redisPubSub";

// Every client joins a room named `org:<orgId>` on connect, derived from their
// own JWT — never from anything the client sends — so org-scoping holds for
// WebSocket traffic the same way requireAuth + org_id filtering holds for REST.
export function initSocketServer(httpServer: HttpServer) {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN || "http://localhost:5173" },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("Missing auth token"));
    try {
      const user = verifyToken(token);
      socket.data.user = user;
      next();
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    const { orgId } = socket.data.user;
    socket.join(`org:${orgId}`);

    socket.on("disconnect", () => {
      // socket.io removes room membership automatically on disconnect.
    });
  });

  // One subscription per backend instance, fanning out to whichever of that
  // instance's sockets belong to the target org's room.
  subscriber.subscribe(INCIDENT_EVENTS_CHANNEL);
  subscriber.on("message", (_channel, raw) => {
    let msg: IncidentEventMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "incident:triage-ready" || msg.type === "incident:postmortem-ready") {
      io.to(`org:${msg.orgId}`).emit(msg.type, { incidentId: msg.incidentId });
    } else {
      io.to(`org:${msg.orgId}`).emit(msg.type, msg.incident);
    }
  });

  return io;
}
