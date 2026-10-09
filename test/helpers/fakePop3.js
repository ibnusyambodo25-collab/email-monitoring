// Server POP3 palsu (RFC 1939 secukupnya) untuk pengujian. Mencatat semua perintah
// yang diterima, sehingga test bisa memastikan DELE tidak pernah dikirim dan RETR
// hanya dipanggil untuk email yang cocok.
import net from 'node:net';

export async function startFakePop3({
  messages = [],
  user = 'erwin.it@gracia.co.id',
  password = 'rahasia-Benar-123',
  passError = null,
  silent = false,
} = {}) {
  const commands = [];
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (silent) return; // tidak pernah menyapa: untuk menguji timeout
    let buffer = '';
    let authed = false;
    let givenUser = null;
    const send = (s) => socket.write(s);
    const multi = (head, body) => {
      const text = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const stuffed = dotStuff(text);
      const end = stuffed.length && !stuffed.subarray(-2).equals(Buffer.from('\r\n')) ? '\r\n.\r\n' : '.\r\n';
      socket.write(Buffer.concat([Buffer.from(`+OK ${head}\r\n`), stuffed, Buffer.from(end)]));
    };
    send('+OK Fake POP3 ready\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const [cmd, ...args] = line.split(' ');
        const name = cmd.toUpperCase();
        commands.push(name === 'PASS' ? 'PASS ***' : line);

        if (name === 'USER') {
          givenUser = args.join(' ');
          send('+OK\r\n');
        } else if (name === 'PASS') {
          if (passError) send(`-ERR ${passError}\r\n`);
          else if (givenUser === user && args.join(' ') === password) {
            authed = true;
            send('+OK Logged in.\r\n');
          } else send('-ERR [AUTH] Authentication failed.\r\n');
        } else if (name === 'QUIT') {
          send('+OK Bye\r\n');
          socket.end();
        } else if (!authed) {
          send('-ERR Not authenticated\r\n');
        } else if (name === 'STAT') {
          const size = messages.reduce((a, m) => a + m.raw.length, 0);
          send(`+OK ${messages.length} ${size}\r\n`);
        } else if (name === 'UIDL') {
          multi('', messages.map((m, i) => `${i + 1} ${m.uidl}\r\n`).join(''));
        } else if (name === 'TOP') {
          const m = messages[Number(args[0]) - 1];
          if (!m) send('-ERR no such message\r\n');
          else multi('', headerPart(m.raw));
        } else if (name === 'RETR') {
          const m = messages[Number(args[0]) - 1];
          if (!m) send('-ERR no such message\r\n');
          else multi(`${m.raw.length} octets`, m.raw);
        } else if (name === 'DELE') {
          send('-ERR fake server: DELE should never be sent\r\n');
        } else {
          send('-ERR unknown command\r\n');
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    commands,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function headerPart(raw) {
  const i = raw.indexOf('\r\n\r\n');
  return i === -1 ? raw : raw.subarray(0, i + 4);
}

function dotStuff(buf) {
  const s = buf.toString('latin1').replace(/(^|\r\n)\./g, '$1..');
  return Buffer.from(s, 'latin1');
}
