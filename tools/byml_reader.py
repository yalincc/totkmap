"""Minimal BYML v7 binary reader.

只实现读 RSDB 表够用的部分。本机原有的 `byml` 模块在当前解释器
不可用（ModuleNotFoundError），而 BYML v7 格式本身很简单，
自己解析比装包/找依赖更快，且不会引入版本差异。

用法:
    import byml_reader
    rows = byml_reader.load('tools/_quest/Challenge.byml')['root']
"""

import struct


# BYML v7 value type -> 是否定长（定长类型后面紧跟 payload）
_STRING = 0x0D
_STRINGREF = 0x0E


def read(f):
    # ★ magic 是**小端 u16** 0x4259（= 'YB'），不是 4 字节 b'BYML'。
    #   按 4 字节读会拿到 b'YB\x07\x00' 直接报 'not a BYML file'（踩过）。
    (magic,) = struct.unpack('<H', f.read(2))
    if magic != 0x4259:
        raise ValueError('not a BYML file (magic=0x%04X)' % magic)
    (ver,) = struct.unpack('<H', f.read(2))
    if ver != 7:
        raise ValueError('unsupported BYML version %d' % ver)
    (heap_type,) = struct.unpack('<H', f.read(2))
    (hash_size,) = struct.unpack('<I', f.read(4))

    # 字符串池：u32 条数，然后每条 = u16 长度 + UTF-8 字节
    (n_str,) = struct.unpack('<I', f.read(4))
    strings = []
    for _ in range(n_str):
        (ln,) = struct.unpack('<H', f.read(2))
        strings.append(f.read(ln).decode('utf-8', 'replace'))

    def read_value():
        (t,) = struct.unpack('<H', f.read(2))
        if t == 0x00:                                  # NULL
            return None
        if t == 0x01:                                  # BOOL
            return f.read(1)[0] != 0
        if t == 0x02:                                  # INT32
            return struct.unpack('<i', f.read(4))[0]
        if t == 0x03:                                  # FLOAT
            return struct.unpack('<f', f.read(4))[0]
        if t == 0x04:                                  # DOUBLE
            return struct.unpack('<d', f.read(8))[0]
        if t == 0x05:                                  # HASHKEY
            return struct.unpack('<I', f.read(4))[0]
        if t == 0x06:                                  # HASHKEYREF
            return struct.unpack('<I', f.read(4))[0]
        if t == 0x07:                                  # BOOLV2
            return f.read(1)[0] != 0
        if t == 0x08:                                  # SUBFLOAT
            return f.read(4)
        if t == 0x09:                                  # INT64
            return struct.unpack('<q', f.read(8))[0]
        if t == 0x0A or t == 0x0B:                     # ARRAY / ARRAY_V2
            (n,) = struct.unpack('<I', f.read(4))
            return [read_value() for _ in range(n)]
        if t == 0x0C:                                  # HASH
            (n,) = struct.unpack('<I', f.read(4))
            return {read_value(): read_value() for _ in range(n)}
        if t == _STRING or t == _STRINGREF:           # 池内字符串引用
            (i,) = struct.unpack('<I', f.read(4))
            return strings[i]
        if t == 0x0F:                                  # RAW / BIN
            (ln,) = struct.unpack('<I', f.read(4))
            return f.read(ln)
        raise ValueError('unknown BYML value type 0x%02X' % t)

    return read_value()


def load(path):
    with open(path, 'rb') as f:
        return read(f)


def load_rows(path):
    """读 RSDB 表，返回 root 的 key -> row dict。"""
    data = load(path)
    if isinstance(data, dict) and 'root' in data:
        return data['root']
    return data