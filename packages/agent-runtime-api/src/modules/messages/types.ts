export interface SessionMessage {
  role: string;
  content: unknown;
  timestamp?: string;
}

export interface MessagesService {
  getSessionMessages(sessionId: string, opts?: { limit?: number; offset?: number }): Promise<SessionMessage[]>;
}
