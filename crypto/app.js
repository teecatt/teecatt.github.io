/* 加密工具箱 — 纯前端实现
 * 仅保留常见编码 / 哈希 / 对称与非对称加密 / 字符集 / 时间戳等工具。
 * 数据全部在浏览器本地处理，不发起任何网络请求。
 */

"use strict";

/* ───────────────────────── 基础工具 ───────────────────────── */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function bytesToHex(bytes, sep = "", upper = false) {
    const h = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(sep);
    return upper ? h.toUpperCase() : h;
}

function hexToBytes(str) {
    const s = String(str).replace(/[^0-9a-fA-F]/g, "");
    if (s.length % 2 !== 0) throw new Error("十六进制字符串长度必须为偶数");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
}

function bytesToB64(bytes, urlSafe = false, pad = true) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    let s = btoa(bin);
    if (urlSafe) s = s.replace(/\+/g, "-").replace(/\//g, "_");
    if (!pad) s = s.replace(/=+$/, "");
    return s;
}

function b64ToBytes(str) {
    let s = String(str).trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const rem = s.length % 4;
    if (rem) s += "=".repeat(4 - rem);
    let bin;
    try {
        bin = atob(s);
    } catch (e) {
        throw new Error("无效的 Base64 字符串");
    }
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function textToBytes(str, enc) {
    if (enc === "latin1") {
        const a = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff;
        return a;
    }
    if (enc === "utf8" || !enc) return new TextEncoder().encode(str);
    return new TextEncoder(enc, { NONSTANDARD_allowLegacyEncoding: true }).encode(str);
}

function bytesToText(bytes, enc) {
    if (enc === "latin1") {
        let s = "";
        for (const b of bytes) s += String.fromCharCode(b);
        return s;
    }
    return new TextDecoder(enc || "utf-8", { fatal: false }).decode(bytes);
}

function parseFmt(str, fmt) {
    switch (fmt) {
        case "hex": return hexToBytes(str);
        case "base64": return b64ToBytes(str);
        case "latin1": return textToBytes(str, "latin1");
        case "utf8":
        default: return textToBytes(str, "utf8");
    }
}

function formatBytes(bytes, fmt) {
    switch (fmt) {
        case "hex": return bytesToHex(bytes);
        case "base64": return bytesToB64(bytes);
        case "base64url": return bytesToB64(bytes, true, false);
        case "latin1": return bytesToText(bytes, "latin1");
        case "utf8":
        default: return bytesToText(bytes, "utf8");
    }
}

function derToPem(der, label) {
    const b64 = bytesToB64(der instanceof Uint8Array ? der : new Uint8Array(der));
    const lines = b64.match(/.{1,64}/g) || [b64];
    return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

function pemToDer(pem) {
    const body = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    if (!body) throw new Error("无效的 PEM 内容");
    return b64ToBytes(body);
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function md5Bytes(bytes) {
    return md5(Array.from(bytes));
}

const FMT_OPTS = [["utf8", "文本 (UTF-8)"], ["hex", "十六进制"], ["base64", "Base64"], ["latin1", "Latin1"]];
const OUT_FMT_OPTS = [["hex", "十六进制"], ["base64", "Base64"], ["utf8", "文本 (UTF-8)"], ["base64url", "Base64URL"]];
const ENC_OPTS = [
    ["utf-8", "UTF-8"], ["gbk", "GBK"], ["gb18030", "GB18030"], ["gb2312", "GB2312"],
    ["big5", "Big5"], ["latin1", "Latin1"], ["utf-16le", "UTF-16LE"], ["utf-16be", "UTF-16BE"],
    ["shift_jis", "Shift_JIS"], ["euc-kr", "EUC-KR"], ["ascii", "ASCII"]
];

/* ───────────────────────── 工具定义 ───────────────────────── */

const TOOLS = [

/* ── 编码 / 解码 ── */
{
    id: "base64", group: "编码 / 解码", name: "Base64 编解码",
    desc: "标准 / URL 安全 Base64 编码解码，可处理文本、十六进制与二进制。",
    input: { label: "输入" },
    fields: [
        { k: "mode", label: "模式", type: "select", options: [["encode", "编码"], ["decode", "解码"]], value: "encode" },
        { k: "variant", label: "变体", type: "select", options: [["std", "标准"], ["url", "URL 安全"]], value: "std" },
        { k: "pad", label: "填充 =", type: "checkbox", value: true },
        { k: "inFmt", label: "编码时输入格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "outFmt", label: "解码时输出格式", type: "select", options: OUT_FMT_OPTS, value: "utf8" }
    ],
    run(input, v) {
        if (v.mode === "encode") {
            return bytesToB64(parseFmt(input, v.inFmt), v.variant === "url", v.pad);
        }
        return formatBytes(b64ToBytes(input), v.outFmt);
    }
},
{
    id: "hex", group: "编码 / 解码", name: "十六进制编解码",
    desc: "文本 / 字节与十六进制字符串互转，支持分隔符与大小写。",
    input: { label: "输入" },
    fields: [
        { k: "mode", label: "模式", type: "select", options: [["encode", "编码"], ["decode", "解码"]], value: "encode" },
        { k: "inFmt", label: "编码时输入格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "outFmt", label: "解码时输出格式", type: "select", options: OUT_FMT_OPTS, value: "utf8" },
        { k: "sep", label: "分隔符", type: "select", options: [["", "无"], [" ", "空格"], [":", "冒号"], [",", "逗号"], ["-", "短横线"]], value: " " },
        { k: "upper", label: "大写", type: "checkbox", value: false }
    ],
    run(input, v) {
        if (v.mode === "encode") return bytesToHex(parseFmt(input, v.inFmt), v.sep, v.upper);
        return formatBytes(hexToBytes(input), v.outFmt);
    }
},
{
    id: "url", group: "编码 / 解码", name: "URL 编解码",
    desc: "对 URL 整体或单个参数进行百分号编码 / 解码。",
    input: { label: "输入" },
    fields: [
        { k: "mode", label: "模式", type: "select", options: [["encode", "编码"], ["decode", "解码"]], value: "encode" },
        { k: "part", label: "范围", type: "select", options: [["component", "参数 (encodeURIComponent)"], ["full", "完整 URL (encodeURI)"]], value: "component" }
    ],
    run(input, v) {
        try {
            if (v.mode === "encode") return v.part === "component" ? encodeURIComponent(input) : encodeURI(input);
            return v.part === "component" ? decodeURIComponent(input) : decodeURI(input);
        } catch (e) {
            throw new Error("无效的百分号编码");
        }
    }
},
{
    id: "charcode", group: "编码 / 解码", name: "ASCII / 字符码",
    desc: "文本与字符码点互转（十进制 / 十六进制 / 八进制 / 二进制）。",
    input: { label: "输入" },
    fields: [
        { k: "mode", label: "模式", type: "select", options: [["encode", "文本 → 码点"], ["decode", "码点 → 文本"]], value: "encode" },
        { k: "base", label: "进制", type: "select", options: [["10", "十进制"], ["16", "十六进制"], ["8", "八进制"], ["2", "二进制"]], value: "10" },
        { k: "sep", label: "分隔符", type: "select", options: [[" ", "空格"], [",", "逗号"], ["", "无"]], value: " " }
    ],
    run(input, v) {
        const base = parseInt(v.base, 10);
        if (v.mode === "encode") {
            return Array.from(input).map(ch => ch.codePointAt(0).toString(base)).join(v.sep);
        }
        const parts = input.trim().split(/[\s,]+/).filter(Boolean);
        return parts.map(p => {
            const n = parseInt(p, base);
            if (isNaN(n)) throw new Error("无法解析码点：" + p);
            return String.fromCodePoint(n);
        }).join("");
    }
},
{
    id: "htmlentity", group: "编码 / 解码", name: "HTML 实体",
    desc: "HTML 实体编码 / 解码，非 ASCII 字符使用数字实体。",
    input: { label: "输入" },
    fields: [
        { k: "mode", label: "模式", type: "select", options: [["encode", "编码"], ["decode", "解码"]], value: "encode" }
    ],
    run(input, v) {
        if (v.mode === "encode") {
            return input.replace(/[&<>"']|[^\u0000-\u007f]/g, ch => {
                const named = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
                return named || "&#" + ch.codePointAt(0) + ";";
            });
        }
        const ta = document.createElement("textarea");
        ta.innerHTML = input;
        return ta.value;
    }
},
{
    id: "unicode", group: "编码 / 解码", name: "Unicode 转义",
    desc: "将非 ASCII 字符转义为 \\uXXXX，或反向还原。",
    input: { label: "输入" },
    fields: [
        { k: "mode", label: "模式", type: "select", options: [["encode", "转义"], ["decode", "还原"]], value: "encode" }
    ],
    run(input, v) {
        if (v.mode === "encode") {
            let out = "";
            for (const ch of input) {
                const cp = ch.codePointAt(0);
                if (cp > 0x7f) {
                    if (cp > 0xffff) {
                        const h = cp - 0x10000;
                        out += "\\u" + (0xd800 + (h >> 10)).toString(16).padStart(4, "0").toUpperCase();
                        out += "\\u" + (0xdc00 + (h & 0x3ff)).toString(16).padStart(4, "0").toUpperCase();
                    } else {
                        out += "\\u" + cp.toString(16).padStart(4, "0").toUpperCase();
                    }
                } else out += ch;
            }
            return out;
        }
        return input.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (m, a, b) =>
            String.fromCodePoint(parseInt(a || b, 16)));
    }
},
{
    id: "radix", group: "编码 / 解码", name: "进制转换",
    desc: "任意 2–36 进制之间的大整数互转，支持负数。",
    input: { label: "输入数字" },
    fields: [
        { k: "from", label: "源进制", type: "number", value: 10, min: 2, max: 36 },
        { k: "to", label: "目标进制", type: "number", value: 16, min: 2, max: 36 },
        { k: "group", label: "每 4 位加空格", type: "checkbox", value: false }
    ],
    run(input, v) {
        let s = input.trim().replace(/[\s_,]/g, "").toLowerCase();
        if (!s) return "";
        let neg = false;
        if (s[0] === "-") { neg = true; s = s.slice(1); }
        const from = +v.from, to = +v.to;
        const prefix = { 2: "0b", 8: "0o", 16: "0x" }[from];
        if (prefix && s.startsWith(prefix)) s = s.slice(2);
        if (!s) return "";
        let n = 0n;
        for (const ch of s) {
            const d = parseInt(ch, 36);
            if (isNaN(d) || d >= from) throw new Error("包含非法字符：" + ch);
            n = n * BigInt(from) + BigInt(d);
        }
        let out = (neg ? "-" : "") + n.toString(to);
        if (v.group) out = out.replace(/\B(?=(.{4})+$)/g, " ");
        return out;
    }
},
{
    id: "float", group: "编码 / 解码", name: "浮点数 / IEEE754",
    desc: "浮点数与十六进制字节互转，支持 float32 / float64 与字节序。",
    input: { label: "输入" },
    fields: [
        { k: "mode", label: "模式", type: "select", options: [["toHex", "浮点数 → Hex"], ["fromHex", "Hex → 浮点数"]], value: "toHex" },
        { k: "size", label: "精度", type: "select", options: [["f32", "float32 (4 字节)"], ["f64", "float64 (8 字节)"]], value: "f32" },
        { k: "endian", label: "字节序", type: "select", options: [["big", "大端"], ["little", "小端"]], value: "big" }
    ],
    run(input, v) {
        const little = v.endian === "little";
        if (v.mode === "toHex") {
            const num = Number(input.trim());
            if (isNaN(num)) throw new Error("不是有效的数字");
            const buf = new ArrayBuffer(v.size === "f32" ? 4 : 8);
            const dv = new DataView(buf);
            if (v.size === "f32") dv.setFloat32(0, num, little); else dv.setFloat64(0, num, little);
            return bytesToHex(new Uint8Array(buf), " ");
        }
        const bytes = hexToBytes(input);
        const need = v.size === "f32" ? 4 : 8;
        if (bytes.length !== need) throw new Error("需要 " + need + " 字节，实际 " + bytes.length);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return String(v.size === "f32" ? dv.getFloat32(0, little) : dv.getFloat64(0, little));
    }
},
{
    id: "endian", group: "编码 / 解码", name: "字节序 / 大小端",
    desc: "按 2/4/8 字节为一组反转十六进制数据的字节顺序。",
    input: { label: "十六进制输入" },
    fields: [
        { k: "size", label: "每组字节", type: "select", options: [["2", "2"], ["4", "4"], ["8", "8"], ["1", "1 (整体反转)"]], value: "4" }
    ],
    run(input, v) {
        const bytes = hexToBytes(input);
        const n = parseInt(v.size, 10);
        if (n === 1) return bytesToHex(bytes.slice().reverse(), " ");
        const out = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i += n) {
            const end = Math.min(i + n, bytes.length);
            const chunk = bytes.slice(i, end).reverse();
            out.set(chunk, i);
        }
        return bytesToHex(out, " ");
    }
},

/* ── 哈希 / 校验 ── */
{
    id: "md5", group: "哈希 / 校验", name: "MD5",
    desc: "计算 MD5 摘要（128 位）。注意 MD5 已不适合用于安全场景。",
    input: { label: "输入" },
    fields: [
        { k: "inFmt", label: "输入格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "outFmt", label: "输出格式", type: "select", options: OUT_FMT_OPTS, value: "hex" },
        { k: "upper", label: "大写", type: "checkbox", value: false }
    ],
    run(input, v) {
        const h = md5Bytes(parseFmt(input, v.inFmt));
        const bytes = hexToBytes(h);
        let out = formatBytes(bytes, v.outFmt);
        if (v.outFmt === "hex" && v.upper) out = out.toUpperCase();
        return out;
    }
},
{
    id: "sha", group: "哈希 / 校验", name: "SHA 摘要",
    desc: "SHA-1 / SHA-256 / SHA-384 / SHA-512 摘要计算。",
    input: { label: "输入" },
    fields: [
        { k: "algo", label: "算法", type: "select", options: [["SHA-1", "SHA-1"], ["SHA-256", "SHA-256"], ["SHA-384", "SHA-384"], ["SHA-512", "SHA-512"]], value: "SHA-256" },
        { k: "inFmt", label: "输入格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "outFmt", label: "输出格式", type: "select", options: OUT_FMT_OPTS, value: "hex" },
        { k: "upper", label: "大写", type: "checkbox", value: false }
    ],
    async run(input, v) {
        const buf = await crypto.subtle.digest(v.algo, parseFmt(input, v.inFmt));
        let out = formatBytes(new Uint8Array(buf), v.outFmt);
        if (v.outFmt === "hex" && v.upper) out = out.toUpperCase();
        return out;
    }
},
{
    id: "hmac", group: "哈希 / 校验", name: "HMAC",
    desc: "基于 SHA-1 / SHA-256 / SHA-384 / SHA-512 的消息认证码。",
    input: { label: "消息" },
    fields: [
        { k: "algo", label: "算法", type: "select", options: [["SHA-1", "SHA-1"], ["SHA-256", "SHA-256"], ["SHA-384", "SHA-384"], ["SHA-512", "SHA-512"]], value: "SHA-256" },
        { k: "key", label: "密钥", type: "text", value: "", random: { bytes: 32 } },
        { k: "keyFmt", label: "密钥格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "outFmt", label: "输出格式", type: "select", options: OUT_FMT_OPTS, value: "hex" }
    ],
    async run(input, v) {
        const key = await crypto.subtle.importKey("raw", parseFmt(v.key, v.keyFmt), { name: "HMAC", hash: v.algo }, false, ["sign"]);
        const sig = await crypto.subtle.sign("HMAC", key, textToBytes(input, "utf8"));
        return formatBytes(new Uint8Array(sig), v.outFmt);
    }
},
{
    id: "crc32", group: "哈希 / 校验", name: "CRC32",
    desc: "计算 CRC-32 (IEEE 802.3) 校验值。",
    input: { label: "输入" },
    fields: [
        { k: "inFmt", label: "输入格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "outFmt", label: "输出格式", type: "select", options: [["hex", "十六进制"], ["dec", "十进制"]], value: "hex" }
    ],
    run(input, v) {
        const c = crc32(parseFmt(input, v.inFmt));
        return v.outFmt === "dec" ? String(c) : c.toString(16).padStart(8, "0");
    }
},
{
    id: "argon2id", group: "哈希 / 校验", name: "Argon2id 口令哈希",
    desc: "内存硬密码哈希（Argon2id）。盐必须随机且每个密码唯一，参数可按需调整，默认适合本地使用。",
    auto: false,
    input: { label: "口令" },
    fields: [
        { k: "salt", label: "盐（Salt）", type: "text", value: "", random: { bytes: 16 } },
        { k: "saltFmt", label: "盐格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "time", label: "迭代次数 (t)", type: "number", value: 3, min: 1 },
        { k: "mem", label: "内存 MiB (m)", type: "number", value: 64, min: 8 },
        { k: "parallelism", label: "并行度 (p)", type: "number", value: 1, min: 1 },
        { k: "hashLen", label: "输出长度 (字节)", type: "number", value: 32, min: 4 }
    ],
    async run(input, v) {
        const salt = parseFmt(v.salt, v.saltFmt);
        if (salt.length < 8) throw new Error("盐至少 8 字节（当前 " + salt.length + "），请点击“随机”生成");
        const mem = +v.mem;
        if (!(mem >= 8 && mem <= 1024)) throw new Error("内存参数应在 8~1024 MiB 之间（当前 " + v.mem + "），过大可能导致页面卡死或 OOM");
        let res;
        try {
            res = await argon2.hash({
                pass: input,
                salt,
                time: +v.time,
                mem: mem * 1024,
                parallelism: +v.parallelism,
                hashLen: +v.hashLen,
                type: 2
            });
        } catch (e) {
            throw new Error("Argon2 计算失败：" + (e && e.message || e));
        }
        return [
            "Argon2id 编码串：",
            res.encoded,
            "",
            "原始十六进制：",
            bytesToHex(res.hash),
            "",
            "原始 Base64：",
            bytesToB64(res.hash)
        ].join("\n");
    }
},
{
    id: "pbkdf2", group: "哈希 / 校验", name: "PBKDF2 密钥派生",
    desc: "基于口令派生密钥（PBKDF2），常用于 AES 等对称加密。",
    auto: false,
    input: { label: "口令" },
    fields: [
        { k: "salt", label: "盐（Salt）", type: "text", value: "", random: { bytes: 16 } },
        { k: "saltFmt", label: "盐格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "iter", label: "迭代次数", type: "number", value: 100000, min: 1 },
        { k: "hash", label: "哈希", type: "select", options: [["SHA-1", "SHA-1"], ["SHA-256", "SHA-256"], ["SHA-512", "SHA-512"]], value: "SHA-256" },
        { k: "len", label: "输出长度 (字节)", type: "number", value: 32, min: 1 }
    ],
    async run(input, v) {
        const salt = parseFmt(v.salt, v.saltFmt);
        if (!salt.length) throw new Error("盐不能为空，请点击“随机”生成（建议 16 字节）");
        const baseKey = await crypto.subtle.importKey("raw", textToBytes(input, "utf8"), "PBKDF2", false, ["deriveBits"]);
        const bits = await crypto.subtle.deriveBits(
            { name: "PBKDF2", salt, iterations: +v.iter, hash: v.hash },
            baseKey, +v.len * 8
        );
        const bytes = new Uint8Array(bits);
        return ["十六进制：", bytesToHex(bytes), "", "Base64：", bytesToB64(bytes)].join("\n");
    }
},

/* ── 对称加密 ── */
{
    id: "aes", group: "对称加密", name: "AES 加解密",
    desc: "AES-128/192/256，支持 GCM（认证加密）、CTR、CBC。密钥长度须为 16/24/32 字节；GCM/CTR 的 IV 绝不可重复使用，请用“随机”生成并随密文保存。",
    input: { label: "明文 / 密文" },
    fields: [
        { k: "mode", label: "模式", type: "select", options: [["encrypt", "加密"], ["decrypt", "解密"]], value: "encrypt" },
        { k: "algo", label: "算法模式", type: "select", options: [["AES-GCM", "AES-GCM"], ["AES-CTR", "AES-CTR"], ["AES-CBC", "AES-CBC"]], value: "AES-GCM" },
        { k: "key", label: "密钥", type: "text", value: "" },
        { k: "keyFmt", label: "密钥格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "iv", label: "IV / Nonce / Counter", type: "text", value: "", random: { bytes: 16 } },
        { k: "ivFmt", label: "IV 格式", type: "select", options: FMT_OPTS, value: "hex" },
        { k: "aad", label: "AAD（仅 GCM，可留空）", type: "text", value: "" },
        { k: "inFmt", label: "输入格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "outFmt", label: "输出格式", type: "select", options: [["base64", "Base64"], ["hex", "十六进制"], ["utf8", "文本 (UTF-8)"]], value: "base64" }
    ],
    async run(input, v) {
        const keyBytes = parseFmt(v.key, v.keyFmt);
        const iv = parseFmt(v.iv, v.ivFmt);
        const data = parseFmt(input, v.inFmt);
        const enc = v.mode === "encrypt";
        if (![16, 24, 32].includes(keyBytes.length)) throw new Error("AES 密钥长度必须是 16/24/32 字节（当前 " + keyBytes.length + "）");
        if (!iv.length) throw new Error("IV/Nonce 不能为空，请点击“随机”生成（GCM 建议 12 字节，CTR/CBC 必须 16 字节）");
        if (v.algo === "AES-GCM" && iv.length !== 12 && iv.length !== 16) throw new Error("GCM 的 IV 建议 12 字节（当前 " + iv.length + "）");
        if (v.algo === "AES-CTR" && iv.length !== 16) throw new Error("CTR 的计数器必须是 16 字节（当前 " + iv.length + "）");
        if (v.algo === "AES-CBC" && iv.length !== 16) throw new Error("CBC 的 IV 必须是 16 字节（当前 " + iv.length + "）");
        let params;
        if (v.algo === "AES-GCM") {
            params = { name: "AES-GCM", iv, tagLength: 128 };
            if (v.aad) params.additionalData = textToBytes(v.aad, "utf8");
        } else if (v.algo === "AES-CTR") params = { name: "AES-CTR", counter: iv, length: 64 };
        else params = { name: "AES-CBC", iv };
        const key = await crypto.subtle.importKey("raw", keyBytes, v.algo, false, [enc ? "encrypt" : "decrypt"]);
        const res = enc ? await crypto.subtle.encrypt(params, key, data) : await crypto.subtle.decrypt(params, key, data);
        return formatBytes(new Uint8Array(res), v.outFmt);
    }
},
{
    id: "xor", group: "对称加密", name: "XOR 异或",
    desc: "使用重复密钥对数据进行异或，加解密为同一操作。⚠ 仅用于混淆：不提供机密性强度与完整性校验，严禁用于真实密钥/机密数据。",
    input: { label: "输入" },
    fields: [
        { k: "key", label: "密钥", type: "text", value: "" },
        { k: "keyFmt", label: "密钥格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "inFmt", label: "输入格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "outFmt", label: "输出格式", type: "select", options: OUT_FMT_OPTS, value: "hex" }
    ],
    run(input, v) {
        const data = parseFmt(input, v.inFmt);
        const key = parseFmt(v.key, v.keyFmt);
        if (!key.length) throw new Error("请填写密钥");
        const out = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
        return formatBytes(out, v.outFmt);
    }
},

/* ── 非对称 / RSA ── */
{
    id: "rsa-keygen", group: "非对称 / RSA", name: "RSA 密钥对生成",
    desc: "生成 RSA 密钥对并以 PEM 输出（PKCS#8 私钥 / SPKI 公钥），可用于加密与签名。",
    auto: false,
    input: { show: false },
    outputLabel: "密钥",
    fields: [
        { k: "bits", label: "密钥长度", type: "select", options: [["2048", "2048 位"], ["3072", "3072 位"], ["4096", "4096 位"]], value: "2048" }
    ],
    async run(input, v) {
        const kp = await crypto.subtle.generateKey(
            { name: "RSA-OAEP", modulusLength: +v.bits, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
            true, ["encrypt", "decrypt"]
        );
        const pk8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
        const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
        return [
            "----- 私钥 (PKCS#8) -----",
            derToPem(pk8, "PRIVATE KEY"),
            "",
            "----- 公钥 (SPKI) -----",
            derToPem(spki, "PUBLIC KEY")
        ].join("\n");
    }
},
{
    id: "rsa-crypt", group: "非对称 / RSA", name: "RSA 加密 / 解密",
    desc: "使用 PEM 密钥进行 RSA-OAEP 加密或解密（适合加密短数据或密钥）。",
    auto: false,
    input: { label: "明文 / 密文" },
    fields: [
        { k: "mode", label: "模式", type: "select", options: [["encrypt", "公钥加密"], ["decrypt", "私钥解密"]], value: "encrypt" },
        { k: "key", label: "PEM 密钥", type: "textarea", value: "", full: true, rows: 5 },
        { k: "hash", label: "OAEP 哈希", type: "select", options: [["SHA-1", "SHA-1"], ["SHA-256", "SHA-256"], ["SHA-512", "SHA-512"]], value: "SHA-256" },
        { k: "inFmt", label: "输入格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "outFmt", label: "输出格式", type: "select", options: [["base64", "Base64"], ["hex", "十六进制"], ["utf8", "文本 (UTF-8)"]], value: "base64" }
    ],
    async run(input, v) {
        const der = pemToDer(v.key);
        const algo = { name: "RSA-OAEP", hash: v.hash };
        if (v.mode === "encrypt") {
            const key = await crypto.subtle.importKey("spki", der, algo, false, ["encrypt"]);
            const res = await crypto.subtle.encrypt(algo, key, parseFmt(input, v.inFmt));
            return formatBytes(new Uint8Array(res), v.outFmt);
        }
        const key = await crypto.subtle.importKey("pkcs8", der, algo, false, ["decrypt"]);
        const res = await crypto.subtle.decrypt(algo, key, parseFmt(input, v.inFmt));
        // 解密结果按用户选择的输出格式返回：二进制明文不再被强制当作 UTF-8（原实现忽略 outFmt）
        return formatBytes(new Uint8Array(res), v.outFmt);
    }
},
{
    id: "rsa-sign", group: "非对称 / RSA", name: "RSA 签名 / 验签",
    desc: "RSA-PSS 或 RSASSA-PKCS1-v1_5 签名与验签。验签时输入框填签名，消息单独填写。",
    auto: false,
    input: { label: "签名（验签时）" },
    fields: [
        { k: "mode", label: "模式", type: "select", options: [["sign", "私钥签名"], ["verify", "公钥验签"]], value: "sign" },
        { k: "scheme", label: "方案", type: "select", options: [["RSA-PSS", "RSA-PSS"], ["RSASSA-PKCS1-v1_5", "RSASSA-PKCS1-v1_5"]], value: "RSA-PSS" },
        { k: "key", label: "PEM 密钥", type: "textarea", value: "", full: true, rows: 5 },
        { k: "message", label: "消息（验签时填写 / 签名时用输入框）", type: "textarea", value: "", full: true, rows: 4 },
        { k: "hash", label: "哈希", type: "select", options: [["SHA-1", "SHA-1"], ["SHA-256", "SHA-256"], ["SHA-512", "SHA-512"]], value: "SHA-256" },
        { k: "saltLen", label: "PSS 盐长度", type: "number", value: 32, min: 0 },
        { k: "outFmt", label: "签名输出格式", type: "select", options: [["base64", "Base64"], ["hex", "十六进制"], ["base64url", "Base64URL"]], value: "base64" }
    ],
    async run(input, v) {
        const der = pemToDer(v.key);
        const isPss = v.scheme === "RSA-PSS";
        const algo = isPss
            ? { name: "RSA-PSS", hash: v.hash }
            : { name: "RSASSA-PKCS1-v1_5", hash: v.hash };
        if (v.mode === "sign") {
            const key = await crypto.subtle.importKey("pkcs8", der, algo, false, ["sign"]);
            const params = isPss ? { name: "RSA-PSS", saltLength: +v.saltLen } : algo;
            const sig = await crypto.subtle.sign(params, key, textToBytes(v.message || input, "utf8"));
            return formatBytes(new Uint8Array(sig), v.outFmt);
        }
        const key = await crypto.subtle.importKey("spki", der, algo, false, ["verify"]);
        const params = isPss ? { name: "RSA-PSS", saltLength: +v.saltLen } : algo;
        // 签名输入格式必须与“签名输出格式”一致：原实现硬编码 base64，选了 hex 必然验签失败
        const sigFmt = v.outFmt === "base64url" ? "base64" : (v.outFmt || "base64");
        const ok = await crypto.subtle.verify(params, key, parseFmt(input, sigFmt), textToBytes(v.message, "utf8"));
        return ok ? "✓ 签名有效" : "✗ 签名无效";
    }
},

/* ── 字符集转换 ── */
{
    id: "charset", group: "字符集转换", name: "字符集转换",
    desc: "在 UTF-8 / GBK / GB2312 / GB18030 / Big5 / Latin1 等编码之间转换。",
    input: { label: "输入" },
    fields: [
        { k: "from", label: "源字符集", type: "select", options: ENC_OPTS, value: "gbk" },
        { k: "to", label: "目标字符集", type: "select", options: ENC_OPTS, value: "utf-8" },
        { k: "inFmt", label: "输入格式", type: "select", options: FMT_OPTS, value: "hex" },
        { k: "outFmt", label: "输出格式", type: "select", options: OUT_FMT_OPTS, value: "utf8" }
    ],
    run(input, v) {
        const bytes = parseFmt(input, v.inFmt);
        const text = bytesToText(bytes, v.from);
        const outBytes = textToBytes(text, v.to);
        return formatBytes(outBytes, v.outFmt);
    }
},

/* ── 时间 / 日期 ── */
{
    id: "timestamp", group: "时间 / 日期", name: "时间戳转换",
    desc: "Unix 时间戳与日期互转，支持纳秒 / 微秒 / 毫秒 / 秒，纳秒精度显示。",
    input: { label: "输入（时间戳或日期）" },
    fields: [
        { k: "mode", label: "方向", type: "select", options: [["ts2time", "时间戳 → 时间"], ["time2ts", "时间 → 时间戳"]], value: "ts2time" },
        { k: "unit", label: "时间戳单位", type: "select", options: [["auto", "自动判断"], ["s", "秒"], ["ms", "毫秒"], ["us", "微秒"], ["ns", "纳秒"]], value: "auto" },
        { k: "outUnit", label: "输出单位", type: "select", options: [["s", "秒"], ["ms", "毫秒"], ["us", "微秒"], ["ns", "纳秒"]], value: "s" },
        { k: "zone", label: "时区", type: "select", options: [["local", "本地"], ["utc", "UTC"]], value: "local" },
        { k: "format", label: "日期格式", type: "text", value: "YYYY-MM-DD HH:mm:ss.SSS", full: true }
    ],
    run(input, v) {
        if (v.mode === "ts2time") {
            const ns = parseTsToNs(input, v.unit);
            return readout(ns, v);
        }
        const ns = parseDateToNs(input);
        const scale = { s: 10n ** 9n, ms: 10n ** 6n, us: 10n ** 3n, ns: 1n }[v.outUnit];
        const val = ns / scale;
        return "时间戳（" + v.outUnit + "）：\n" + val.toString() + "\n\n" + readout(ns, v);
    }
},
{
    id: "timediff", group: "时间 / 日期", name: "时间差计算",
    desc: "计算两个时间戳之间的差值（支持 s / ms / us / ns）。",
    auto: true,
    input: { show: false },
    fields: [
        { k: "t1", label: "时间戳 1", type: "text", value: "", full: true },
        { k: "t2", label: "时间戳 2", type: "text", value: "", full: true },
        { k: "unit", label: "单位", type: "select", options: [["auto", "自动判断"], ["s", "秒"], ["ms", "毫秒"], ["us", "微秒"], ["ns", "纳秒"]], value: "auto" }
    ],
    run(input, v) {
        const a = parseTsToNs(v.t1, v.unit), b = parseTsToNs(v.t2, v.unit);
        const d = a > b ? a - b : b - a;
        return [
            "秒  : " + (d / 10n ** 9n).toString(),
            "毫秒: " + (d / 10n ** 6n).toString(),
            "微秒: " + (d / 10n ** 3n).toString(),
            "纳秒: " + d.toString(),
            "",
            humanDuration(d)
        ].join("\n");
    }
},

/* ── 文本 / 其他 ── */
{
    id: "regex", group: "文本 / 其他", name: "正则表达式",
    desc: "正则匹配、提取捕获组、替换或分割文本。",
    input: { label: "文本" },
    fields: [
        { k: "pattern", label: "正则", type: "text", value: "", full: true },
        { k: "flags", label: "标志", type: "text", value: "g" },
        { k: "mode", label: "操作", type: "select", options: [["match", "匹配"], ["extract", "提取捕获组"], ["replace", "替换"], ["split", "分割"]], value: "match" },
        { k: "repl", label: "替换内容", type: "text", value: "", full: true }
    ],
    run(input, v) {
        if (!v.pattern) return "";
        let re;
        try { re = new RegExp(v.pattern, v.flags); } catch (e) { throw new Error("无效的正则表达式：" + e.message); }
        if (v.mode === "match") {
            const m = input.match(re);
            return m ? m.join("\n") : "（无匹配）";
        }
        if (v.mode === "replace") return input.replace(re, v.repl);
        if (v.mode === "split") return input.split(re).join("\n");
        const out = [];
        const rx = new RegExp(v.pattern, v.flags.includes("g") ? v.flags : v.flags + "g");
        let m;
        while ((m = rx.exec(input)) !== null) {
            if (m.length === 1) out.push(m[0]);
            else out.push(m.slice(1).map((g, i) => "  $" + (i + 1) + " = " + (g === undefined ? "" : g)).join("\n"));
            if (m.index === rx.lastIndex) rx.lastIndex++;
            if (!v.flags.includes("g")) break;
        }
        return out.length ? out.join("\n---\n") : "（无匹配）";
    }
},
{
    id: "jwt", group: "文本 / 其他", name: "JWT 解码",
    desc: "解析 JWT 的 Header 与 Payload（不验证签名）。",
    input: { label: "JWT" },
    fields: [],
    run(input) {
        const parts = input.trim().split(".");
        if (parts.length < 2) throw new Error("不是有效的 JWT");
        const dec = p => {
            try { return JSON.stringify(JSON.parse(bytesToText(b64ToBytes(p), "utf-8")), null, 2); }
            catch (e) { return "（无法解析）"; }
        };
        return ["Header:", dec(parts[0]), "", "Payload:", dec(parts[1]), "", "Signature:", parts[2] || ""].join("\n");
    }
},
{
    id: "gzip", group: "文本 / 其他", name: "Gzip / Zlib 压缩",
    desc: "使用 Gzip / Zlib / Deflate 压缩或解压数据。",
    input: { label: "输入" },
    fields: [
        { k: "mode", label: "模式", type: "select", options: [["compress", "压缩"], ["decompress", "解压"]], value: "compress" },
        { k: "format", label: "格式", type: "select", options: [["gzip", "Gzip"], ["zlib", "Zlib"], ["deflate", "Raw Deflate"]], value: "gzip" },
        { k: "inFmt", label: "输入格式", type: "select", options: FMT_OPTS, value: "utf8" },
        { k: "outFmt", label: "输出格式", type: "select", options: OUT_FMT_OPTS, value: "base64" }
    ],
    run(input, v) {
        const data = parseFmt(input, v.inFmt);
        try {
            if (v.mode === "compress") {
                const fn = v.format === "gzip" ? pako.gzip : (v.format === "zlib" ? pako.deflate : pako.deflateRaw);
                return formatBytes(fn(data), v.outFmt);
            }
            const fn = v.format === "gzip" ? pako.ungzip : (v.format === "zlib" ? pako.inflate : pako.inflateRaw);
            return formatBytes(fn(data), v.outFmt);
        } catch (e) {
            throw new Error("压缩 / 解压失败：" + (e && e.message || e));
        }
    }
},
{
    id: "json", group: "文本 / 其他", name: "JSON 格式化",
    desc: "JSON 格式化、压缩与校验。",
    input: { label: "JSON" },
    fields: [
        { k: "mode", label: "模式", type: "select", options: [["format", "格式化"], ["minify", "压缩"]], value: "format" },
        { k: "indent", label: "缩进空格", type: "number", value: 2, min: 0, max: 10 }
    ],
    run(input, v) {
        let obj;
        try { obj = JSON.parse(input); } catch (e) { throw new Error("JSON 解析失败：" + e.message); }
        return v.mode === "minify" ? JSON.stringify(obj) : JSON.stringify(obj, null, +v.indent);
    }
}

];

/* ───────────────────────── 时间戳辅助 ───────────────────────── */

function parseTsToNs(str, unit) {
    let s = String(str).trim().replace(/[,\s]/g, "");
    if (!s) throw new Error("请输入时间戳");
    let neg = false;
    if (s[0] === "-") { neg = true; s = s.slice(1); }
    const dot = s.indexOf(".");
    let intPart = (dot >= 0 ? s.slice(0, dot) : s).replace(/\D/g, "") || "0";
    const fracPart = (dot >= 0 ? s.slice(dot + 1) : "").replace(/\D/g, "");
    let u = unit;
    if (u === "auto") {
        const d = intPart.length;
        if (d >= 19) u = "ns"; else if (d >= 16) u = "us"; else if (d >= 13) u = "ms"; else u = "s";
    }
    const scale = { s: 10n ** 9n, ms: 10n ** 6n, us: 10n ** 3n, ns: 1n }[u];
    let ns = BigInt(intPart) * scale;
    if (fracPart) {
        const denom = 10n ** BigInt(fracPart.length);
        ns += (BigInt(fracPart) * scale) / denom;
    }
    return neg ? -ns : ns;
}

function parseDateToNs(str) {
    let s = String(str).trim();
    let ms = Date.parse(s);
    if (isNaN(ms)) ms = Date.parse(s.replace(" ", "T"));
    if (isNaN(ms)) throw new Error('无法解析日期，请使用 ISO 或 "YYYY-MM-DD HH:mm:ss" 格式');
    return BigInt(ms) * 10n ** 6n;
}

function pad(n, w) { return String(n).padStart(w, "0"); }

function formatDate(ms, zone, fmt) {
    const date = new Date(ms);
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone === "utc" ? "UTC" : undefined,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).formatToParts(date);
    const p = {};
    parts.forEach(x => p[x.type] = x.value);
    const msStr = pad(date.getMilliseconds(), 3);
    return String(fmt || "YYYY-MM-DD HH:mm:ss.SSS")
        .replace(/YYYY/g, p.year).replace(/MM/g, p.month).replace(/DD/g, p.day)
        .replace(/HH/g, p.hour === "24" ? "00" : p.hour)
        .replace(/mm/g, p.minute).replace(/ss/g, p.second).replace(/SSS/g, msStr);
}

function isoFromNs(a) {
    const SEC = 10n ** 9n;
    const sec = a / SEC, rem = a % SEC;
    const date = new Date(Number(sec) * 1000);
    const p = {};
    new Intl.DateTimeFormat("en-CA", {
        timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).formatToParts(date).forEach(x => p[x.type] = x.value);
    const hh = p.hour === "24" ? "00" : p.hour;
    return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}.${pad(rem.toString(), 9)}Z`;
}

function readout(totalNs, v) {
    const SEC = 10n ** 9n;
    const neg = totalNs < 0n;
    const a = neg ? -totalNs : totalNs;
    const sec = a / SEC, rem = a % SEC;
    const ms = Number(sec) * 1000 + Number(rem / 10n ** 6n);
    const sign = neg ? "-" : "";
    return [
        "本地时间 : " + formatDate(ms, "local", v.format),
        "UTC 时间 : " + formatDate(ms, "utc", v.format),
        "ISO 8601 : " + sign + isoFromNs(a),
        "",
        "Unix 秒   : " + sign + (a / 10n ** 9n).toString(),
        "Unix 毫秒 : " + sign + (a / 10n ** 6n).toString(),
        "Unix 微秒 : " + sign + (a / 10n ** 3n).toString(),
        "Unix 纳秒 : " + sign + a.toString()
    ].join("\n");
}

function humanDuration(ns) {
    const units = [["天", 86400n * 10n ** 9n], ["小时", 3600n * 10n ** 9n], ["分钟", 60n * 10n ** 9n], ["秒", 10n ** 9n], ["毫秒", 10n ** 6n]];
    let rest = ns, out = [];
    for (const [name, size] of units) {
        if (rest >= size) { out.push((rest / size).toString() + " " + name); rest %= size; }
    }
    return "约 " + (out.length ? out.slice(0, 3).join(" ") : "0");
}

/* ───────────────────────── 渲染与交互 ───────────────────────── */

const state = { current: null };

function buildNav() {
    const nav = $("#nav");
    let html = "";
    let lastGroup = "";
    for (const t of TOOLS) {
        if (t.group !== lastGroup) {
            html += `<div class="nav-group">${esc(t.group)}</div>`;
            lastGroup = t.group;
        }
        html += `<a class="nav-link" data-id="${t.id}" href="#${t.id}">${esc(t.name)}</a>`;
    }
    nav.innerHTML = html;
    nav.addEventListener("click", e => {
        const a = e.target.closest("a[data-id]");
        if (a) setTimeout(closeSidebar, 0);
    });
}

function fieldHtml(f, val) {
    const v = val === undefined ? f.value : val;
    let inner = "";
    if (f.type === "select") {
        inner = `<select data-k="${f.k}">` + f.options.map(o =>
            `<option value="${esc(o[0])}"${String(o[0]) === String(v) ? " selected" : ""}>${esc(o[1])}</option>`).join("") + "</select>";
    } else if (f.type === "checkbox") {
        return `<div class="field${f.full ? "" : ""}"><label class="check" style="display:flex;align-items:center;gap:8px;color:var(--fg);font-size:14px">
            <input type="checkbox" data-k="${f.k}"${v ? " checked" : ""}> ${esc(f.label)}</label></div>`;
    } else if (f.type === "textarea") {
        inner = `<textarea data-k="${f.k}" rows="${f.rows || 4}">${esc(v)}</textarea>`;
    } else {
        inner = `<input type="${f.type === "number" ? "number" : (f.type === "password" ? "password" : "text")}" data-k="${f.k}" value="${esc(v)}"${f.min !== undefined ? ` min="${f.min}"` : ""}${f.max !== undefined ? ` max="${f.max}"` : ""}>`;
        if (f.random) {
            inner = `<div class="rand-wrap">${inner}<button type="button" class="rand-btn" data-rand="${f.random.bytes}" data-target="${f.k}" title="使用浏览器 CSPRNG 生成随机字节（hex 显示）">随机</button></div>`;
        }
    }
    return `<div class="field"><label>${esc(f.label)}</label>${inner}</div>`;
}

function fieldsHtml(tool) {
    const fields = tool.fields || [];
    let html = "";
    let row = [];
    const flush = () => {
        if (row.length) { html += `<div class="field-row">${row.join("")}</div>`; row = []; }
    };
    for (const f of fields) {
        if (f.full || f.type === "textarea" || f.type === "checkbox") {
            flush();
            html += fieldHtml(f);
        } else {
            row.push(fieldHtml(f));
        }
    }
    flush();
    return html;
}

function renderTool(tool) {
    state.current = tool;
    $$(".nav-link").forEach(a => a.classList.toggle("active", a.dataset.id === tool.id));
    const showInput = !(tool.input && tool.input.show === false);
    const html = `
        <div class="tool-head"><h1>${esc(tool.name)}</h1><p>${esc(tool.desc || "")}</p></div>
        ${fieldsHtml(tool)}
        ${showInput ? `<div class="field"><label>${esc((tool.input && tool.input.label) || "输入")}</label>
            <textarea id="in" class="role-input" placeholder="在此输入…"></textarea></div>` : ""}
        <div class="actions">
            <button class="btn btn-primary" id="run-btn">${tool.auto ? "重新计算" : "执行"}</button>
            <button class="btn" id="clear-btn">清空</button>
            ${showInput ? `<button class="btn" id="paste-btn">粘贴</button>` : ""}
        </div>
        <div class="output-head">
            <label>${esc(tool.outputLabel || "输出")}</label>
            <span class="output-actions"><a class="link-btn" id="copy-btn">复制</a></span>
        </div>
        <div class="output" id="out"></div>`;
    $("#tool").innerHTML = html;

    $("#run-btn").addEventListener("click", runTool);
    $("#clear-btn").addEventListener("click", () => {
        const inp = $("#in"); if (inp) inp.value = "";
        $("#out").textContent = ""; $("#out").classList.remove("error", "ok");
    });
    const paste = $("#paste-btn");
    if (paste) paste.addEventListener("click", async () => {
        try { $("#in").value = await navigator.clipboard.readText(); runTool(); }
        catch (e) { toast("无法读取剪贴板"); }
    });
    $("#copy-btn").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText($("#out").textContent); toast("已复制"); }
        catch (e) { toast("复制失败"); }
    });

    $$("#tool [data-k]").forEach(el => {
        el.addEventListener("input", scheduleRun);
        el.addEventListener("change", scheduleRun);
    });
    $$("#tool .rand-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const n = Math.max(1, Math.min(256, +btn.dataset.rand || 16));
            const bytes = crypto.getRandomValues(new Uint8Array(n));
            const hex = Array.prototype.map.call(bytes, b => b.toString(16).padStart(2, "0")).join("");
            const input = $(`#tool [data-k="${btn.dataset.target}"]`);
            if (input) { input.value = hex; input.dispatchEvent(new Event("input", { bubbles: true })); }
            toast("已生成随机值（" + n + " 字节 hex）");
        });
    });
    const inp = $("#in");
    if (inp) inp.addEventListener("input", scheduleRun);

    if (tool.auto) runTool();
}

function collect() {
    const v = {};
    $$("#tool [data-k]").forEach(el => { v[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value; });
    return v;
}

let runTimer = null;
function scheduleRun() {
    if (!state.current || !state.current.auto) return;
    clearTimeout(runTimer);
    runTimer = setTimeout(runTool, 180);
}

async function runTool() {
    const tool = state.current;
    if (!tool) return;
    const input = tool.input && tool.input.show === false ? "" : ($("#in") ? $("#in").value : "");
    const out = $("#out");
    out.classList.remove("error", "ok");
    try {
        const res = await tool.run(input, collect(), out);
        out.textContent = res === undefined || res === null ? "" : String(res);
        if (/^[✓✗]/.test(out.textContent.trim())) {
            out.classList.add(out.textContent.trim()[0] === "✓" ? "ok" : "error");
        }
    } catch (e) {
        out.classList.add("error");
        out.textContent = "错误：" + (e && e.message ? e.message : e);
    }
}

function route() {
    const id = (location.hash || "").replace(/^#/, "");
    const tool = TOOLS.find(t => t.id === id) || TOOLS[0];
    if (!id) history.replaceState(null, "", "#" + tool.id);
    renderTool(tool);
}

function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 1600);
}

function openSidebar() { $("#sidebar").classList.add("open"); $("#scrim").classList.add("show"); }
function closeSidebar() { $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); }

/* ── 主题与构建信息 ── */
function initTheme() {
    const btn = $("#theme-toggle");
    btn.addEventListener("click", () => {
        const dark = !document.documentElement.classList.contains("dark");
        document.documentElement.classList.toggle("dark", dark);
        try { localStorage.setItem("ct-theme", dark ? "dark" : "light"); } catch (e) {}
    });
}

function initBuildInfo() {
    const b = window.CRYPTO_BUILD;
    const el = $("#buildInfo");
    if (!el) return;
    if (!b || !b.sha) {
        el.textContent = "最近构建：未知";
        return;
    }
    const diff = Date.now() - b.time;
    el.textContent = "最近构建：" + humanizeAgo(diff);
    el.href = "https://github.com/teecatt/teecatt.github.io/commit/" + b.sha;
}

function humanizeAgo(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return "刚刚";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " 分钟前";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " 小时前";
    const d = Math.floor(h / 24);
    if (d < 30) return d + " 天前";
    const mo = Math.floor(d / 30);
    if (mo < 12) return mo + " 个月前";
    return Math.floor(mo / 12) + " 年前";
}

/* ── 初始化 ── */
function init() {
    buildNav();
    initTheme();
    initBuildInfo();
    $("#menu").addEventListener("click", e => {
        e.stopPropagation();
        $("#sidebar").classList.contains("open") ? closeSidebar() : openSidebar();
    });
    $("#scrim").addEventListener("click", closeSidebar);
    window.addEventListener("hashchange", route);
    route();
}

document.addEventListener("DOMContentLoaded", init);
