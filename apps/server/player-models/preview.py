"""Renders a player model in its reference pose and a few animation frames to
one PNG, to check a model gltf2mdl.py wrote without starting the game:

    python3 preview.py urban.mdl preview.png
"""
import sys

import numpy as np
from PIL import Image

import mdlread

# (sequence or None for the reference pose, frame, camera). Aim sequences show
# their first blend, which looks straight up.
SHOTS = [(None, 0, 'side'), (None, 0, 'front'), ('idle1', 0, 'front'), ('idle1', 0, 'side'),
         ('run', 5, 'front'), ('run', 5, 'side'), ('crouch_idle', 0, 'side'),
         ('ref_aim_ak47', 0, 'front'), ('ref_aim_ak47', 0, 'side'), ('ref_aim_ak47', 0, 'back')]

# Screen right, screen down and towards the camera, in model space (X
# forward, Y left, Z up; animations face +X).
CAMERAS = {'front': ([0, 1, 0], [0, 0, -1], [1, 0, 0]),
           'side': ([1, 0, 0], [0, 0, -1], [0, -1, 0]),
           'back': ([0, -1, 0], [0, 0, -1], [-1, 0, 0])}


def render(mdl, mats, camera, size=300, scale=3.6, center=(0, 0, 0)):
    """Orthographic, textured, z-buffered render of body part 0."""
    verts, vbone, norms, nbone, tris = mdl.model(0)
    wv = np.einsum('nij,nj->ni', mats[vbone], np.c_[verts, np.ones(len(verts))])[:, :3] - np.array(center)
    wn = np.einsum('nij,nj->ni', mats[nbone][:, :3, :3], norms)
    sv = wv @ np.array(CAMERAS[camera], dtype=float).T
    sx = sv[:, 0] * scale + size / 2
    sy = sv[:, 1] * scale + size * 0.55
    sz = sv[:, 2]
    light = np.array([0.5, 0.3, 0.8]) / np.linalg.norm([0.5, 0.3, 0.8])
    img = np.full((int(size * 1.1), size, 3), 40, np.uint8)
    zb = np.full(img.shape[:2], -1e9)
    H, W = zb.shape
    for skinref, tri in tris:
        tex = mdl.textures[mdl.skinref[skinref]]
        vi = [t[0] for t in tri]
        st = np.array([t[2:] for t in tri], dtype=float)
        x, y, z = sx[vi], sy[vi], sz[vi]
        x0, x1 = int(max(np.floor(x.min()), 0)), int(min(np.ceil(x.max()), W - 1))
        y0, y1 = int(max(np.floor(y.min()), 0)), int(min(np.ceil(y.max()), H - 1))
        den = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2])
        if x0 > x1 or y0 > y1 or abs(den) < 1e-9:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        l0 = ((y[1] - y[2]) * (gx - x[2]) + (x[2] - x[1]) * (gy - y[2])) / den
        l1 = ((y[2] - y[0]) * (gx - x[2]) + (x[0] - x[2]) * (gy - y[2])) / den
        l2 = 1 - l0 - l1
        zz = l0 * z[0] + l1 * z[1] + l2 * z[2]
        sub = zb[y0:y1 + 1, x0:x1 + 1]
        draw = (l0 >= 0) & (l1 >= 0) & (l2 >= 0) & (zz > sub)
        if not draw.any():
            continue
        s = (l0 * st[0, 0] + l1 * st[1, 0] + l2 * st[2, 0]).astype(int) % tex['w']
        t = (l0 * st[0, 1] + l1 * st[1, 1] + l2 * st[2, 1]).astype(int) % tex['h']
        n = wn[[t[1] for t in tri]].mean(0)
        shade = 0.8 + 0.7 * max(0.0, float(n @ light) / (np.linalg.norm(n) + 1e-9))
        sub[draw] = zz[draw]
        img[y0:y1 + 1, x0:x1 + 1][draw] = (tex['rgb'][t, s] * shade).clip(0, 255).astype(np.uint8)[draw]
    return Image.fromarray(img)


def main(path, out):
    mdl = mdlread.Mdl(path)
    imgs = []
    for seq, frame, camera in SHOTS:
        if seq is not None and seq not in mdl.seqs:
            continue
        mats = mdl.pose(seq, frame)
        root = mats[0][:3, 3]
        imgs.append(render(mdl, mats, camera, center=(root[0], root[1], 0) if seq else (0, 0, 36)))
    cols = 5
    w, h = imgs[0].size
    sheet = Image.new('RGB', (cols * w, -(-len(imgs) // cols) * h))
    for k, im in enumerate(imgs):
        sheet.paste(im, ((k % cols) * w, (k // cols) * h))
    sheet.save(out)


if __name__ == '__main__':
    main(*sys.argv[1:3])
