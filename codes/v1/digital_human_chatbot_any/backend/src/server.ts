import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { commandSchema } from '@digital-human/shared';
import { readConfig } from './config.js';
import { createApplication } from './app.js';
import { runTurn } from './pipeline.js';

const config = readConfig();

const context = await createApplication(config);

const server = createServer(context.app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`);
  const match = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/events$/);
  const session = match ? context.sessions.get(match[1]) : undefined;
  let allowed = true;
  try {
    if (request.headers.origin)
      allowed = ['127.0.0.1', 'localhost', '[::1]'].includes(
        new URL(request.headers.origin).hostname,
      );
  } catch {
    allowed = false;
  }
  if (!session || !allowed) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    if (session.connection) {
      ws.close(1008, 'A session already has a connection');
      return;
    }
    session.connection = ws;
    session.attach((event) => {
      if (ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 1024 * 1024) ws.close(1009, 'Slow client');
        else ws.send(JSON.stringify(event));
      }
    });
    session.send({ type: 'session.ready' }, null);
    session.send({ type: 'scene.state', scene: session.scene.snapshot() }, null);
    session.send({ type: 'memory.state', memories: session.memory.snapshot() }, null);
    ws.on('message', (raw) => {
      try {
        const command = commandSchema.parse(JSON.parse(raw.toString()));
        session.touched = Date.now();
        if (command.type === 'conversation.activity') session.activity();
        else if (command.type === 'proactive.configure') {
          session.activity();
          session.proactive.enabled = command.enabled;
          session.proactive.delaySeconds = command.delaySeconds;
        } else if (command.type === 'turn.send' || command.type === 'turn.proactive') {
          if (session.transcription) {
            session.send({
              type: 'error',
              stage: 'session',
              message: 'Wait for transcription to finish.',
              retryable: false,
            });
            return;
          }
          void runTurn(config, session, command, context.personas, context.media).catch(() => {
            session.send({
              type: 'error',
              stage: 'application',
              message: 'The turn failed unexpectedly.',
              retryable: true,
            });
            session.stop();
          });
        } else if (command.type === 'memory.edit' || command.type === 'memory.forget') {
          if (!session.editMemory(command))
            session.send(
              {
                type: 'error',
                stage: 'memory',
                message:
                  'The conversation changed or the memory no longer exists. Try again when the reply finishes.',
                retryable: false,
              },
              null,
            );
        } else if (command.type === 'scene.configure') {
          session.configureScenes(command.enabled);
        } else if (command.type === 'scene.decide') {
          if (!session.decideScene(command))
            session.send(
              {
                type: 'error',
                stage: 'scene',
                message:
                  'The scene changed or a reply is still active. Try again when it finishes.',
                retryable: false,
              },
              null,
            );
        } else if (command.type === 'turn.stop') {
          if (!command.turnId || session.active?.id === command.turnId) {
            session.stop();
            session.transcription?.abort();
          }
        } else if (command.type === 'session.reset') session.reset();
        else {
          const turn = session.active;
          if (!turn || turn.id !== command.turnId) return;
          if (command.type === 'playback.started') {
            turn.playbackStarted = true;
            session.send({ type: 'state.changed', state: 'Speaking' });
          } else {
            if (command.type === 'playback.failed')
              session.send({
                type: 'error',
                stage: 'playback',
                message: 'Audio playback failed. Check browser playback permissions.',
                retryable: true,
              });
            if (command.type === 'playback.failed') {
              turn.succeeded = false;
              session.finish(turn);
              turn.controller.abort();
            } else if (turn.speechFinished) session.finish(turn);
          }
        }
      } catch {
        session.send({
          type: 'error',
          stage: 'request',
          message: 'Invalid command.',
          retryable: false,
        });
      }
    });
    const disconnected = () => {
      if (session.connection === ws) {
        session.stop();
        session.transcription?.abort();
        session.suggestion?.abort();
        session.connection = undefined;
        session.attach(() => {});
        // Each saved URL opens a fresh live session. Release closed sockets so
        // browsing history does not exhaust the live-session limit.
        void session.archive
          .flush()
          .then(async () => {
            if (!session.connection && context.sessions.get(session.id) === session) {
              context.sessions.delete(session.id);
              await context.media.cleanup(session.id);
            }
          })
          .catch(() => {});
      }
    };
    ws.on('close', disconnected);
    ws.on('error', disconnected);
    ws.on('pong', () => (session.touched = Date.now()));
  });
});

const ping = setInterval(() => {
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.ping();
}, 30000);

ping.unref();

server.listen(config.APP_PORT, config.APP_HOST, () =>
  console.log(`Digital Human API: http://${config.APP_HOST}:${config.APP_PORT}`),
);

let closing = false;

async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(ping);
  for (const ws of wss.clients) ws.close(1001, 'Server stopping');
  await context.close();
  server.close();
  wss.close();
}

process.on('SIGINT', () => void shutdown());

process.on('SIGTERM', () => void shutdown());
