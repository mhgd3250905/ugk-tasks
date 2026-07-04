// cdp-client.mjs — 零依赖 node 直连 Chrome DevTools Protocol。
// ponytail: 复刻框架 chrome_cdp 工具的最小子集(HTTP /json/list + WebSocket Runtime.evaluate),
// 因为 bash 起的 node 用不了 LLM 的 chrome_cdp 工具。5 个 search taskbook 共用此文件。
// 协议对齐 extensions/chrome-cdp/client.ts:returnByValue:true, awaitPromise:true, id 匹配。
//
// 用法:
//   const cdp = createCdpClient();          // 端口读 UGK_CDP_PORT || 9222
//   const tab = await cdp.findTab({ urlContains: "linkedin.com" });  // 复用现有 tab,反爬单 tab 规则
//   const value = await cdp.evaluate(tab, expression, { timeoutMs: 300000 });
//
// WebSocket 实现:优先 globalThis.WebSocket(Node 21+ 内置);否则手写最小帧客户端(Node 14+ 兜底)。
// 不引入 npm 依赖(ws / chrome-remote-interface 等),YAGNI。

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

function getPort() {
	const p = Number(process.env.UGK_CDP_PORT || 9222);
	return Number.isFinite(p) && p > 0 ? p : 9222;
}

// --- HTTP /json/list:返回 page 类型 target(对齐 client.ts listChromeTabs)---
async function listTabs(port) {
	return new Promise((resolve, reject) => {
		const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
			let body = "";
			res.on("data", (chunk) => (body += chunk));
			res.on("end", () => {
				try {
					const targets = JSON.parse(body);
					resolve(targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl));
				} catch (e) {
					reject(new Error(`CDP /json/list malformed: ${body.slice(0, 200)}`));
				}
			});
		});
		req.on("error", reject);
		req.setTimeout(5000, () => req.destroy(new Error("CDP /json/list timed out (Chrome 没起?用 chrome_cdp action=launch)")));
	});
}

// --- WebSocket:内置优先,手写兜底 ---
function makeWebSocket(url) {
	if (typeof globalThis.WebSocket === "function") {
		const ws = new globalThis.WebSocket(url);
		return {
			onopen: (fn) => (ws.onopen = fn),
			onmessage: (fn) => (ws.onmessage = (e) => fn(typeof e.data === "string" ? e.data : "")),
			onerror: (fn) => (ws.onerror = fn),
			close: () => { try { ws.close(); } catch {} },
			send: (data) => ws.send(data),
		};
	}
	// ponytail: 手写最小 WS 客户端(~30 行)。只够连 CDP(127.0.0.1,无 TLS,小帧)。
	// 不实现分片发送/扩展/permessage-deflate —— CDP evaluate 的 request 都是小 JSON,够用。
	const { hostname, port, pathname } = new URL(url);
	const sock = net.connect(Number(port) || 80, hostname);
	const key = crypto.randomBytes(16).toString("base64");
	let opened = false, frameBuf = Buffer.alloc(0), msgCb, openCb, errCb;
	sock.on("connect", () => {
		sock.write(
			`GET ${pathname} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
			`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
		);
	});
	sock.on("data", (chunk) => {
		frameBuf = Buffer.concat([frameBuf, chunk]);
		if (!opened) {
			const idx = frameBuf.indexOf("\r\n\r\n");
			if (idx === -1) return;
			if (!/^HTTP\/1\.1 101/.test(frameBuf.slice(0, idx).toString("ascii"))) {
				errCb?.(new Error(`WS handshake failed: ${frameBuf.slice(0, idx).toString("ascii").slice(0, 200)}`));
				return sock.destroy();
			}
			frameBuf = frameBuf.slice(idx + 4);
			opened = true;
			openCb?.();
		}
		// 解析帧:fin/opcode/mask(服务器帧不 mask)/payload len
		while (opened && frameBuf.length >= 2) {
			const b0 = frameBuf[0], b1 = frameBuf[1];
			const opcode = b0 & 0x0f;
			let len = b1 & 0x7f, idx = 2;
			if (len === 126) { if (frameBuf.length < 4) return; len = frameBuf.readUInt16BE(2); idx = 4; }
			else if (len === 127) { if (frameBuf.length < 10) return; len = Number(frameBuf.readBigUInt64BE(2)); idx = 10; }
			if (frameBuf.length < idx + len) return;
			const payload = frameBuf.slice(idx, idx + len);
			frameBuf = frameBuf.slice(idx + len);
			if (opcode === 0x1) msgCb?.(payload.toString("utf8"));      // text
			else if (opcode === 0x8) { sock.destroy(); return; }        // close
		}
	});
	sock.on("error", (e) => errCb?.(e));
	return {
		onopen: (fn) => (openCb = fn),
		onmessage: (fn) => (msgCb = fn),
		onerror: (fn) => (errCb = fn),
		close: () => { try { sock.destroy(); } catch {} },
		send: (data) => {
			const payload = Buffer.from(data, "utf8");
			const len = payload.length;
			let header;
			if (len < 126) header = Buffer.from([0x81, 0x80 | len]); // fin+text, client mask
			else if (len < 65536) header = Buffer.from([0x81, 0xfe, 0, 0, 0, 0]); // placeholder, fill below
			else header = Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0, 0, 0]);
			// 客户端帧必须 mask(RFC 6455)。手写 4 字节 mask key。
			const mask = crypto.randomBytes(4);
			const masked = Buffer.alloc(len);
			for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
			if (len < 126) { header[1] |= 0x80; sock.write(Buffer.concat([header, mask, masked])); }
			else if (len < 65536) { header.writeUInt16BE(len, 2); header[1] |= 0x80; sock.write(Buffer.concat([header, mask, masked])); }
			else { header.writeBigUInt64BE(BigInt(len), 2); header[1] |= 0x80; sock.write(Buffer.concat([header, mask, masked])); }
		},
	};
}

// --- 发一条 CDP 命令,等 id 匹配的响应(对齐 client.ts sendCdpCommand)---
function sendCdp(ws, method, params, timeoutMs = 10000) {
	const clamped = Math.min(Math.max(timeoutMs, 1000), 300000); // 钳位 1s~5min
	return new Promise((resolve, reject) => {
		const id = 1;
		const timer = setTimeout(() => { ws.close(); reject(new Error(`CDP timed out: ${method}`)); }, clamped);
		ws.onopen(() => ws.send(JSON.stringify({ id, method, params })));
		ws.onerror((e) => { clearTimeout(timer); reject(new Error(`CDP WS error: ${String(e?.message || e)}`)); });
		ws.onmessage((raw) => {
			let msg;
			try { msg = JSON.parse(raw); } catch { clearTimeout(timer); ws.close(); reject(new Error(`CDP malformed: ${raw.slice(0, 200)}`)); return; }
			if (msg.id !== id) return;
			clearTimeout(timer); ws.close();
			if (msg.error) reject(new Error(msg.error.message || `CDP failed: ${method}`));
			else resolve(msg.result);
		});
	});
}

export function createCdpClient(port = getPort()) {
	return {
		port,
		async listTabs() { return listTabs(port); },
		// 优先用 UGK_CDP_TAB_ID(worker 专属 tab,与框架 tab-session.ts 对齐);
		// 否则按 urlContains/titleContains 匹配(反爬单 tab 规则);都没有 fallback tabs[0]。
		// ponytail: 若 sessionTabId 设了但找不到,强制报错(不静默 fallback 到错的 tab 产出脏数据)。
		async findTab(filter = {}) {
			const tabs = await listTabs(port);
			const sessionTabId = process.env.UGK_CDP_TAB_ID;
			if (sessionTabId) {
				const tab = tabs.find((t) => t.id === sessionTabId) ?? null;
				if (!tab?.webSocketDebuggerUrl) {
					throw new Error(`UGK_CDP_TAB_ID=${sessionTabId} 设了但找不到对应 tab(可见 tabs=${tabs.length})。tab 可能已被回收,或 chrome_cdp 未就绪。可见 tab: ${tabs.map(t=>t.id).slice(0,5).join(",")}`);
				}
				return tab;
			}
			const tab = (filter.urlContains || filter.titleContains
				? tabs.find((t) =>
					(filter.urlContains && t.url?.includes(filter.urlContains)) ||
					(filter.titleContains && t.title?.includes(filter.titleContains)))
				: tabs[0]) ?? null;
			if (!tab?.webSocketDebuggerUrl) {
				throw new Error(`CDP tab not found (filter=${JSON.stringify(filter)}, 可见 tabs=${tabs.length}). Chrome 起了没?`);
			}
			return tab;
		},
		// 对齐 evaluateChromeExpression:returnByValue+awaitPromise,返回 result.result.value,抛 exceptionDetails。
		async evaluate(tab, expression, { timeoutMs = 300000 } = {}) {
			const ws = makeWebSocket(tab.webSocketDebuggerUrl);
			const result = await sendCdp(ws, "Runtime.evaluate",
				{ expression, returnByValue: true, awaitPromise: true }, timeoutMs);
			if (result.exceptionDetails) {
				const ex = result.exceptionDetails;
				const text = ex.exception?.description || ex.text || "unknown page error";
				throw new Error(`CDP evaluate threw: ${String(text).slice(0, 500)}`);
			}
			return result.result?.value;
		},
	};
}
