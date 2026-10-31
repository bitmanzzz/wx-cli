"""LLDB 断点回调：从微信进程抓 SQLCipher 密钥。

用法（在 lldb 里）：
    command script import /path/to/lldb_capture.py
    breakpoint set -n CCKeyDerivationPBKDF
    breakpoint command add 1 -F lldb_capture.on_pbkdf
    ...

命中后打印 `WXKEY <64 hex>`，返回 False 让进程自动继续。
"""

import lldb

PREFIX = "WXKEY"
KEY_LEN = 32


def _is_arm(frame):
    triple = lldb.debugger.GetSelectedTarget().GetTriple()
    return "arm64" in triple or "aarch64" in triple


def _reg(frame, name):
    return frame.FindRegister(name).GetValueAsUnsigned()


def _emit_key(frame, key_reg, len_reg):
    try:
        if _reg(frame, len_reg) != KEY_LEN:
            return False
        addr = _reg(frame, key_reg)
        if not addr:
            return False
        process = frame.GetThread().GetProcess()
        err = lldb.SBError()
        data = process.ReadMemory(addr, KEY_LEN, err)
        if err.Success() and data and len(data) == KEY_LEN:
            print("%s %s" % (PREFIX, bytes(data).hex()))
    except Exception as exc:  # 回调里抛异常会让 lldb 停下，这里必须吞掉
        print("WXKEY-ERROR %s" % exc)
    return False


def _read_mem(frame, addr, size):
    if not addr or size <= 0 or size > 256:
        return None
    process = frame.GetThread().GetProcess()
    err = lldb.SBError()
    data = process.ReadMemory(addr, size, err)
    if not err.Success() or data is None or len(data) != size:
        return None
    return bytes(data)


def on_pbkdf(frame, bp_loc, internal_dict):
    """CCKeyDerivationPBKDF(alg, password, passwordLen, salt, saltLen, prf, rounds, out, outLen)

    arm64: x0=alg x1=password x2=passwordLen x3=salt x4=saltLen x5=prf x6=rounds x7=out x8=outLen
    """
    try:
        arm = _is_arm(frame)
        pw_ptr = _reg(frame, "x1" if arm else "rsi")
        pw_len = _reg(frame, "x2" if arm else "rdx")
        salt_ptr = _reg(frame, "x3" if arm else "rcx")
        salt_len = _reg(frame, "x4" if arm else "r8")
        pw = _read_mem(frame, pw_ptr, pw_len if pw_len <= 128 else 0)
        salt = _read_mem(frame, salt_ptr, salt_len if salt_len <= 128 else 0)
        if arm and pw and salt:
            prf = _reg(frame, "x5")
            rounds = _reg(frame, "x6")
            out_len = _reg(frame, "x8")
            print("WXPBKDF rounds=%d prf=%d outlen=%d salt=%s pw=%s"
                  % (rounds, prf, out_len, salt.hex(), pw.hex()))
        if pw and len(pw) == KEY_LEN:
            print("%s %s" % (PREFIX, pw.hex()))
    except Exception as exc:
        print("WXKEY-ERROR %s" % exc)
    return False


def on_aes_create(frame, bp_loc, internal_dict):
    """CCCryptorCreate(op, alg, options, key, keyLength, iv, ...)"""
    if _is_arm(frame):
        return _emit_key(frame, "x3", "x4")
    return _emit_key(frame, "rcx", "r8")


def on_aes(frame, bp_loc, internal_dict):
    """CCCrypt(op, alg, options, key, keyLength, iv, ...)"""
    return on_aes_create(frame, bp_loc, internal_dict)
