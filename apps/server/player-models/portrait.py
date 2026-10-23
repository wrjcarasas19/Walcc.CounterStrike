"""Renders a player model as its team and character menu picture
(cstrike/gfx/vgui/<name>.tga, read by apps/client/src/vgui-pictures.ts): the
character from the knees up in a three-quarter view, aiming level, with a
stock weapon model merged onto its bones the way the engine attaches it.
Run by the Dockerfile player-models-converted stage:

    python3 portrait.py --model urban.mdl --weapon p_m4a1.mdl --seq ref_aim_carbine --out urban.tga
"""
import argparse
import struct

import numpy as np
from PIL import Image

import mdlread

# The stock pictures' size; 32-bit with alpha, bottom-up rows.
WIDTH, HEIGHT = 256, 196
SUPERSAMPLE = 3
# Of the character's height, from the top of the head down: knees up.
SHOWN = 0.68

# Screen right, screen down and towards the camera, in model space (X
# forward, Y left, Z up): from the character's front right, a little above.
_toward = np.array([0.75, -0.62, 0.22])
_toward /= np.linalg.norm(_toward)
_right = np.cross([0, 0, 1], _toward)
_right /= np.linalg.norm(_right)
CAMERA = np.array([_right, -np.cross(_toward, _right), _toward])
# Light from above the camera's left, in model space.
LIGHT = CAMERA.T @ np.array([-0.4, -0.7, 0.6])
LIGHT /= np.linalg.norm(LIGHT)
# A cool white edge light for the rim highlight.
RIM_COLOUR = np.array([200.0, 210.0, 235.0])


def merged_pose(weapon, mats, names):
    """The weapon's bone matrices: bones named like the player's take the
    player's (the engine's StudioMergeBones), the rest follow their parent
    with their own reference transform."""
    own = weapon.pose()
    out = []
    for b, bone in enumerate(weapon.bones):
        if bone['name'] in names:
            out.append(mats[names.index(bone['name'])])
        elif bone['parent'] >= 0:
            p = bone['parent']
            out.append(out[p] @ np.linalg.inv(own[p]) @ own[b])
        else:
            out.append(own[b])
    return np.stack(out)


def meshes(mdl, mats):
    """(model-space positions, normals, triangles) of each body part's first
    model, what the engine draws by default."""
    out = []
    for bp in range(mdl.numbodyparts):
        verts, vbone, norms, nbone, tris = mdl.model(bp)
        if not tris:
            continue
        pos = np.einsum('nij,nj->ni', mats[vbone], np.c_[verts, np.ones(len(verts))])[:, :3]
        nrm = np.einsum('nij,nj->ni', mats[nbone][:, :3, :3], norms)
        nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-9
        out.append((mdl, pos, nrm, tris))
    return out


def load(path):
    """A model with its textures: a model without any keeps them in <name>T.mdl,
    which the engine loads next to it."""
    mdl = mdlread.Mdl(path)
    if mdl.numtex == 0:
        t = mdlread.Mdl(path[:-4] + 'T.mdl')
        mdl.textures, mdl.skinref = t.textures, t.skinref
    return mdl


def rasterize(img, zb, mdl, pos, nrm, tris, to_screen, exposure, rim):
    sx, sy, sz = to_screen(pos)
    shade = exposure * (0.45 + 0.75 * np.clip(nrm @ LIGHT, 0, None))
    # Strongest where the surface turns away from the camera: outlines a dark
    # character against the menu's dark cards.
    edge = rim * (1 - np.clip(nrm @ CAMERA[2], 0, 1)) ** 3
    H, W = zb.shape
    for skinref, tri in tris:
        tex = mdl.textures[mdl.skinref[skinref]]
        vi = [t[0] for t in tri]
        ni = [t[1] for t in tri]
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
        light = l0 * shade[ni[0]] + l1 * shade[ni[1]] + l2 * shade[ni[2]]
        glow = l0 * edge[ni[0]] + l1 * edge[ni[1]] + l2 * edge[ni[2]]
        sub[draw] = zz[draw]
        rgb = (tex['rgb'][t, s] * light[..., None] + glow[..., None] * RIM_COLOUR).clip(0, 255).astype(np.uint8)
        img[y0:y1 + 1, x0:x1 + 1, :3][draw] = rgb[draw]
        img[y0:y1 + 1, x0:x1 + 1, 3][draw] = 255


def portrait(model_path, weapon_path, seq, exposure=1.0, rim=0.0):
    mdl = load(model_path)
    names = [b['name'] for b in mdl.bones]
    mats = mdl.pose(seq, 0, mdl.seqs[seq]['numblends'] // 2)  # the middle blend aims level
    parts = meshes(mdl, mats)
    body = np.concatenate([p[1] for p in parts])
    if weapon_path:
        weapon = load(weapon_path)
        parts += meshes(weapon, merged_pose(weapon, mats, names))

    # Frame the character alone (the weapon may leave the picture).
    view = body @ CAMERA.T
    top, bottom = view[:, 1].min(), view[:, 1].max()
    span = SHOWN * (bottom - top)
    shown = view[view[:, 1] <= top + span]
    w, h = WIDTH * SUPERSAMPLE, HEIGHT * SUPERSAMPLE
    scale = h * 0.95 / span
    cx = (shown[:, 0].min() + shown[:, 0].max()) / 2

    def to_screen(pos):
        v = pos @ CAMERA.T
        return (v[:, 0] - cx) * scale + w / 2, (v[:, 1] - top) * scale + h * 0.03, v[:, 2]

    img = np.zeros((h, w, 4), np.uint8)
    zb = np.full((h, w), -1e9)
    for part in parts:
        rasterize(img, zb, *part, to_screen, exposure, rim)
    # Average colour over covered samples only, so edges don't darken.
    a = img[..., 3:].astype(float) / 255
    rgb = (img[..., :3] * a).reshape(HEIGHT, SUPERSAMPLE, WIDTH, SUPERSAMPLE, 3).sum((1, 3))
    cover = a.reshape(HEIGHT, SUPERSAMPLE, WIDTH, SUPERSAMPLE, 1).sum((1, 3))
    out = np.zeros((HEIGHT, WIDTH, 4), np.uint8)
    out[..., :3] = (rgb / np.maximum(cover, 1e-9)).clip(0, 255)
    out[..., 3] = (cover[..., 0] / SUPERSAMPLE ** 2 * 255).round()
    return out


def write_tga(path, rgba):
    """Uncompressed 32-bit true colour, bottom-up, 8 alpha bits: the stock layout."""
    header = struct.pack('<3B2HB4H2B', 0, 0, 2, 0, 0, 0, 0, 0, WIDTH, HEIGHT, 32, 8)
    with open(path, 'wb') as f:
        f.write(header + rgba[::-1][..., [2, 1, 0, 3]].tobytes())


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', required=True, help='player model')
    ap.add_argument('--weapon', help='weapon model held in the picture (p_*.mdl)')
    ap.add_argument('--seq', required=True, help='aim sequence, such as ref_aim_carbine')
    ap.add_argument('--out', required=True, help='TGA to write')
    ap.add_argument('--png', help='also write a PNG, to look at')
    ap.add_argument('--exposure', type=float, default=1.0, help='scale of the lighting (1: as the others)')
    ap.add_argument('--rim', type=float, default=0.0, help='strength of an edge light, for dark characters (0: none)')
    a = ap.parse_args()
    rgba = portrait(a.model, a.weapon, a.seq, a.exposure, a.rim)
    write_tga(a.out, rgba)
    if a.png:
        Image.fromarray(rgba).save(a.png)
