// Máy chủ đa người chơi cho game Măng Đen — không cần cài thư viện, chỉ cần Node.js >= 18.
//   node server.js                 (cổng 8080)
//   PORT=3000 MAX_PER_ROOM=50 MAX_ROOMS=1 node server.js
// Thiết kế để nhẹ máy chủ:
//  - Giới hạn cứng MAX_PER_ROOM người/phòng, tối đa MAX_ROOMS phòng. Hết chỗ -> báo {t:'full'} và client tự chơi một mình cùng bot (không tốn tài nguyên máy chủ).
//  - Máy chủ chỉ chuyển tiếp vị trí (không mô phỏng thế giới), mỗi phòng gom gói tin và gửi 5 lần/giây.
//  - Chỉ gửi cho mỗi người những người chơi ở gần (AOI_R) và chỉ khi họ có thay đổi.
//  - Giới hạn tốc độ gửi + kích thước gói của mỗi client, tự ngắt kết nối im lặng.
const http = require('http'), crypto = require('crypto');
const PORT = +process.env.PORT || 8080;
const MAX_PER_ROOM = +process.env.MAX_PER_ROOM || 50;
const EMOTES = ['wave', 'sit', 'dance', 'like', 'love', 'haha', 'wow', 'sad', 'angry'];
const MAX_ROOMS = +process.env.MAX_ROOMS || 1;
const TICK_MS = +process.env.TICK_MS || 100;
const AOI_R = +process.env.AOI_R || 120;          // bán kính quan tâm (đơn vị game)
const AOI_MAX = +process.env.AOI_MAX || 24;       // tối đa số người gửi cho mỗi client mỗi nhịp
const MAX_MSG = 512;                              // byte
const MAX_RATE = 25;                              // gói/giây/client
const IDLE_MS = 45000;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

let nextId = 1, seqCounter = 1;
const rooms = [];                                 // mỗi phần tử: Map(id -> client)
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, n);
const num = (v, lo, hi) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0; };

// ---------- WebSocket tối giản (RFC 6455) ----------
function frame(str) {
  const p = Buffer.from(str), n = p.length;
  const h = n < 126 ? Buffer.from([0x81, n]) : Buffer.from([0x81, 126, n >> 8, n & 255]);
  return Buffer.concat([h, p]);
}
function parseFrames(c) {                         // trả về các gói văn bản đã giải mã
  const out = [];
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1], op = b0 & 15; let len = b1 & 127, off = 2;
    if (len === 126) { if (c.buf.length < 4) break; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { return null; }        // quá lớn
    if (!(b1 & 128)) return null;                 // client phải che (mask) dữ liệu
    if (len > MAX_MSG) return null;
    if (c.buf.length < off + 4 + len) break;
    const mask = c.buf.subarray(off, off + 4), data = Buffer.from(c.buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    c.buf = c.buf.subarray(off + 4 + len);
    if (op === 8) return null;
    if (op === 9) { c.sock.write(Buffer.from([0x8a, 0])); continue; }   // ping -> pong
    if (op === 10) { c.alive = Date.now(); continue; }
    if (op === 1) out.push(data.toString('utf8'));
  }
  return out;
}

// ---------- phòng ----------
function send(c, obj) { if (!c.sock.destroyed) c.sock.write(frame(JSON.stringify(obj))); }
function placeInRoom(c) {
  for (const r of rooms) if (r.size < MAX_PER_ROOM) { r.set(c.id, c); c.room = r; return true; }
  if (rooms.length < MAX_ROOMS) { const r = new Map(); rooms.push(r); r.set(c.id, c); c.room = r; return true; }
  return false;
}
function roster(c) {
  const a = []; c.room.forEach(o => { if (o !== c) a.push([o.id, o.n, o.s]); }); return a;
}
function drop(c) {
  if (c.gone) return; c.gone = true;
  if (c.room) { c.room.delete(c.id); c.room.forEach(o => { o.seen.delete(c.id); send(o, { t: 'l', id: c.id }); send(o, { t: 'o', n: c.room.size }); }); }
  try { c.sock.destroy(); } catch (e) {}
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.map(r => r.size), capacity: MAX_PER_ROOM * MAX_ROOMS }));
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Mang Den multiplayer server');
});
server.on('upgrade', (req, sock) => {
  const origin = req.headers.origin || '';
  if (ORIGINS.length && !ORIGINS.includes(origin)) { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { id: nextId++, sock, buf: Buffer.alloc(0), room: null, n: 'Du khách', s: 0, x: 0, z: 0, yaw: 0, sp: 0, em: null, bk: 0, bt: 0, jy: 0, seq: 0, seen: new Map(), alive: Date.now(), win: 0, cnt: 0, hello: false, gone: false };
  sock.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]); if (c.buf.length > 4 * MAX_MSG) return drop(c);
    const msgs = parseFrames(c); if (msgs === null) return drop(c);
    for (const m of msgs) handle(c, m);
  });
  sock.on('close', () => drop(c)); sock.on('error', () => drop(c));
  setTimeout(() => { if (!c.hello) drop(c); }, 5000);   // phải chào trong 5 giây
});
function handle(c, text) {
  const now = Date.now(); c.alive = now;
  if (now - c.win > 1000) { c.win = now; c.cnt = 0; }
  if (++c.cnt > MAX_RATE) return;                       // bỏ gói thừa, không tốn công xử lý
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello' && !c.hello) {
    c.hello = true; c.n = clean(m.n, 24) || 'Du khách'; c.s = num(m.s, 0, 31) | 0;
    c.x = num(m.x, -1e4, 1e4); c.z = num(m.z, -1e4, 1e4);
    if (!placeInRoom(c)) { send(c, { t: 'full', cap: MAX_PER_ROOM * MAX_ROOMS }); c.gone = true; setTimeout(() => c.sock.destroy(), 200); return; }
    send(c, { t: 'w', id: c.id, n: c.room.size, cap: MAX_PER_ROOM, r: roster(c) });
    c.room.forEach(o => { if (o !== c) { send(o, { t: 'j', id: c.id, nm: c.n, s: c.s }); send(o, { t: 'o', n: c.room.size }); } });
    c.seq = 1; return;
  }
  if (!c.room) return;
  if (m.t === 'adm') {   // admin gửi thông báo tới toàn bộ người chơi (cần ADMIN_KEY trên máy chủ)
    if ((c.admFail || 0) >= 5) return;
    const key = process.env.ADMIN_KEY || '1587397561';   // nên đặt biến môi trường ADMIN_KEY trên Render để đổi mật khẩu mà không sửa code
    if (!key) { send(c, { t: 'adm', ok: 0, e: 'nokey' }); return; }
    if (typeof m.k !== 'string' || m.k !== key) { c.admFail = (c.admFail || 0) + 1; send(c, { t: 'adm', ok: 0, e: 'bad' }); return; }
    const txt = clean(m.m, 160);
    if (!txt) { send(c, { t: 'adm', ok: 1, chk: 1 }); return; }   // chỉ kiểm tra mật khẩu khi mở quyền admin
    for (const r of rooms) r.forEach(o => { if (o.hello) send(o, { t: 'ann', m: txt }); });
    return;
  }
  if (m.t === 'p') {
    c.x = num(m.x, -1e4, 1e4); c.z = num(m.z, -1e4, 1e4); c.yaw = num(m.yaw, -20, 20);
    c.sp = num(m.sp, 0, 40); c.em = EMOTES.includes(m.em) ? m.em : null; c.bk = m.bk ? 1 : 0; c.bt = m.bt ? 1 : 0; c.jy = num(m.jy, 0, 6);
    c.seq = ++seqCounter;
  } else if (m.t === 'g') {   // đánh cồng: báo cho người chơi trong vùng quan tâm
    const now = Date.now();
    if (now - (c.gAt || 0) < 500) return;
    c.gAt = now;
    c.room.forEach(o => {
      if (o === c || !o.hello) return;
      const dx = o.x - c.x, dz = o.z - c.z;
      if (dx * dx + dz * dz <= AOI_R * AOI_R) send(o, { t: 'g', id: c.id });
    });
  }
}
// nhịp gửi: mỗi client nhận các người chơi ở gần có thay đổi từ lần gửi trước
setInterval(() => {
  for (const r of rooms) {
    if (r.size < 2) continue;
    r.forEach(c => {
      if (!c.hello) return;
      const near = [], exits = [];
      r.forEach(o => {
        if (o === c || !o.seq) return;
        const dx = o.x - c.x, dz = o.z - c.z, d2 = dx * dx + dz * dz;
        if (d2 > AOI_R * AOI_R) { if (c.seen.has(o.id)) { c.seen.delete(o.id); exits.push(o.id); } return; }   // ra khỏi vùng quan tâm
        if (c.seen.get(o.id) === o.seq) return;                 // không đổi -> không gửi
        near.push([d2, o]);
      });
      if (exits.length) send(c, { t: 'x', a: exits });
      if (!near.length) return;
      near.sort((a, b) => a[0] - b[0]);
      const list = near.slice(0, AOI_MAX).map(([, o]) => { c.seen.set(o.id, o.seq); return [o.id, +o.x.toFixed(2), +o.z.toFixed(2), +o.yaw.toFixed(2), +o.sp.toFixed(1), o.em, o.bk, +o.jy.toFixed(2), o.bt || 0]; });
      send(c, { t: 'u', a: list });
    });
  }
  const now = Date.now();
  rooms.forEach(r => r.forEach(c => { if (now - c.alive > IDLE_MS) drop(c); }));
}, TICK_MS);
setInterval(() => { rooms.forEach(r => r.forEach(c => { if (!c.sock.destroyed) c.sock.write(Buffer.from([0x89, 0])); })); }, 15000);
server.listen(PORT, () => console.log('Mang Den multiplayer server on :' + PORT + ' (' + MAX_PER_ROOM + ' người/phòng, ' + MAX_ROOMS + ' phòng)'));
