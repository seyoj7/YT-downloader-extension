import struct, zlib, math

def make_png(size, r, g, b):
    img = []
    cx = cy = size / 2
    rad = size / 2 - 1

    for y in range(size):
        row = []
        for x in range(size):
            dx, dy = x - cx, y - cy
            dist = math.sqrt(dx*dx + dy*dy)
            if dist > rad:
                row += [0, 0, 0, 0]
            else:
                tx = x - cx
                ty = y - cy
                tri_size = rad * 0.45
                in_tri = (tx >= -tri_size * 0.6 and
                          abs(ty) <= (tx + tri_size * 0.6) * 0.75 and
                          tx <= tri_size * 0.9)
                if in_tri:
                    row += [255, 255, 255, 255]
                else:
                    row += [r, g, b, 255]
        img.append(row)

    # Build PNG binary
    def pack_chunk(tag, data):
        c = zlib.crc32(tag + data) & 0xffffffff
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', c)

    raw = b''
    for row in img:
        raw += b'\x00' + bytes(row)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)

    return (
        b'\x89PNG\r\n\x1a\n' +
        pack_chunk(b'IHDR', ihdr) +
        pack_chunk(b'IDAT', idat) +
        pack_chunk(b'IEND', b'')
    )

import os
out_dir = os.path.join(os.path.dirname(__file__), '..', 'extension', 'icons')
os.makedirs(out_dir, exist_ok=True)

for sz in (16, 48, 128):
    data = make_png(sz, 180, 0, 0)
    path = os.path.join(out_dir, f'icon{sz}.png')
    with open(path, 'wb') as f:
        f.write(data)
    print(f'  Created {path}')

print('Icons generated.')
