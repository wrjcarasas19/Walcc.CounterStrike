"""Puts a Mixamo-rigged glTF character on a Counter-Strike 1.6 player model.

The stock model keeps its skeleton, animations, hitboxes, attachments and its
other body parts (the defuse kit); only body part 0's mesh and the first
texture are replaced. The character is posed onto the stock reference pose
bone by bone, then each vertex is bound to one stock bone (GoldSrc models have
no vertex weights). Run by the Dockerfile player-models-converted stage:

    python3 gltf2mdl.py --stock urban.mdl --gltf palpatine/Unity2Skfb.gltf \\
        --texture palpatine/Darth_Sidious_D.jpeg --name palpatine --out urban.mdl
"""
import argparse
import struct

import numpy as np
from PIL import Image

import gltfload
import mdlread

# Mixamo bone -> (stock bone it follows, Mixamo joint at its tip, stock bone
# at that tip). A bone without a tip keeps its parent's rotation.
BONES = {
    'Hips': ('Bip01 Pelvis', None, None),
    'Spine': ('Bip01 Spine', 'Spine1', 'Bip01 Spine2'),
    'Spine1': ('Bip01 Spine2', 'Spine2', 'Bip01 Spine3'),
    'Spine2': ('Bip01 Spine3', 'Neck', 'Bip01 Neck'),
    'Neck': ('Bip01 Neck', 'Head', 'Bip01 Head'),
    'Head': ('Bip01 Head', None, None),
}
PARENT = {'Spine': 'Hips', 'Spine1': 'Spine', 'Spine2': 'Spine1', 'Neck': 'Spine2', 'Head': 'Neck'}
for _side, _s in (('Left', 'L'), ('Right', 'R')):
    BONES.update({
        _side + 'Shoulder': (f'Bip01 {_s} Clavicle', _side + 'Arm', f'Bip01 {_s} UpperArm'),
        _side + 'Arm': (f'Bip01 {_s} UpperArm', _side + 'ForeArm', f'Bip01 {_s} Forearm'),
        _side + 'ForeArm': (f'Bip01 {_s} Forearm', _side + 'Hand', f'Bip01 {_s} Hand'),
        _side + 'Hand': (f'Bip01 {_s} Hand', None, None),
        _side + 'UpLeg': (f'Bip01 {_s} Thigh', _side + 'Leg', f'Bip01 {_s} Calf'),
        _side + 'Leg': (f'Bip01 {_s} Calf', _side + 'Foot', f'Bip01 {_s} Foot'),
        _side + 'Foot': (f'Bip01 {_s} Foot', _side + 'ToeBase', f'Bip01 {_s} Toe0'),
        _side + 'ToeBase': (f'Bip01 {_s} Toe0', None, None),
    })
    PARENT.update({_side + 'Shoulder': 'Spine2', _side + 'Arm': _side + 'Shoulder',
                   _side + 'ForeArm': _side + 'Arm', _side + 'Hand': _side + 'ForeArm',
                   _side + 'UpLeg': 'Hips', _side + 'Leg': _side + 'UpLeg',
                   _side + 'Foot': _side + 'Leg', _side + 'ToeBase': _side + 'Foot'})


def basis(left, up):
    """Rows forward, left, up; up is kept exactly."""
    up = up / np.linalg.norm(up)
    left = left - (left @ up) * up
    left /= np.linalg.norm(left)
    return np.array([np.cross(left, up), left, up])


def min_rotation(a, b):
    """Smallest rotation turning direction a into direction b."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3)
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + k @ k / (1 + a @ b)


def retarget(joints, prims, stock, ref):
    """The glTF primitives in the stock reference pose, with one stock bone per vertex."""
    names = [b['name'] for b in stock.bones]
    C = {n: ref[i][:3, 3] for i, n in enumerate(names)}
    P = {k: m[:3, 3] for k, m in joints.items()}

    # Line the character up with the stock reference pose: same up (feet to
    # head), same left (right thigh to left thigh), hips on the pelvis, same
    # feet-to-head height.
    c_up = C['Bip01 Head'] - (C['Bip01 L Foot'] + C['Bip01 R Foot']) / 2
    p_up = P['Head'] - (P['LeftFoot'] + P['RightFoot']) / 2
    G = basis(C['Bip01 L Thigh'] - C['Bip01 R Thigh'], c_up).T @ basis(P['LeftUpLeg'] - P['RightUpLeg'], p_up)
    scale = np.linalg.norm(c_up) / np.linalg.norm(p_up)

    def place(x):
        return C['Bip01 Pelvis'] + scale * (x - P['Hips']) @ G.T

    Pg = {k: place(v) for k, v in P.items()}

    # One affine map per Mixamo bone: turn the bone onto its stock bone,
    # stretch it along its length to the stock length, move its head there.
    maps = {}
    for mb in BONES:  # parents come first
        cb, tip, ctip = BONES[mb]
        if tip:
            d_p = Pg[tip] - Pg[mb]
            d_c = C[ctip] - C[cb]
            rot = min_rotation(d_p, d_c)
            u = d_p / np.linalg.norm(d_p)
            lin = rot @ (np.eye(3) + (np.linalg.norm(d_c) / np.linalg.norm(d_p) - 1) * np.outer(u, u))
        elif mb in PARENT:
            lin, _, rot = maps[PARENT[mb]]
        else:
            lin = rot = np.eye(3)
        maps[mb] = (lin, C[cb] - lin @ Pg[mb], rot)

    out = []
    for p in prims:
        v = place(p['pos'])
        n = p['nrm'] @ G.T
        nv = np.zeros_like(v)
        nn = np.zeros_like(n)
        bones = []
        for i in range(len(v)):
            best = (0, None)
            for k in range(4):
                w = p['weights'][i, k]
                if w <= 0:
                    continue
                mb = p['joints'][i][k]
                lin, t, rot = maps[mb]
                nv[i] += w * (lin @ v[i] + t)
                nn[i] += w * (rot @ n[i])
                best = max(best, (w, mb))
            cb = BONES[best[1]][0]
            # The stock spine has one bone more than Mixamo's: the upper part
            # of Mixamo's Spine goes to Spine1.
            if cb == 'Bip01 Spine' and (nv[i] - C['Bip01 Spine1']) @ (C['Bip01 Spine2'] - C['Bip01 Spine']) > 0:
                cb = 'Bip01 Spine1'
            bones.append(names.index(cb))
        nn /= np.linalg.norm(nn, axis=1, keepdims=True)
        out.append(dict(pos=nv, nrm=nn, uv=p['uv'], bone=np.array(bones), tris=p['tris']))
    return out


def body_mesh(parts, ref, texsize):
    """Bone-space vertices and normals (shared where bone and value match)
    and the triangle commands, one 3-vertex strip per triangle."""
    inv = np.linalg.inv(ref)
    verts, vbone, vkey = [], [], {}
    norms, nbone, nkey = [], [], {}
    cmds = bytearray()
    ntris = 0
    for p in parts:
        lv = np.einsum('nij,nj->ni', inv[p['bone']], np.c_[p['pos'], np.ones(len(p['pos']))])[:, :3]
        ln = np.einsum('nij,nj->ni', inv[p['bone']][:, :3, :3], p['nrm'])
        vi, ni = [], []
        for i in range(len(lv)):
            b = int(p['bone'][i])
            k = (b, *np.round(lv[i], 3))
            if k not in vkey:
                vkey[k] = len(verts)
                verts.append(lv[i])
                vbone.append(b)
            vi.append(vkey[k])
            k = (b, *np.round(ln[i], 3))
            if k not in nkey:
                nkey[k] = len(norms)
                norms.append(ln[i])
                nbone.append(b)
            ni.append(nkey[k])
        # Unity2Skfb keeps Unity's bottom-up V; texture rows go top-down.
        st = np.round(np.c_[p['uv'][:, 0], 1 - p['uv'][:, 1]] * texsize).astype(int)
        for a, b, c in p['tris']:
            # GoldSrc front faces wind the other way round from glTF's.
            cmds += struct.pack('<h', 3)
            for x in (a, c, b):
                cmds += struct.pack('<4h', vi[x], ni[x], *st[x])
            ntris += 1
    cmds += struct.pack('<h', 0)
    return verts, vbone, norms, nbone, bytes(cmds), ntris


def quantize(path, size):
    img = Image.open(path).convert('RGB').resize((size, size), Image.LANCZOS)
    q = img.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    return np.asarray(q, dtype=np.uint8).tobytes() + bytes((q.getpalette() + [0] * 768)[:768])


def name_field(s, n):
    return s.encode('latin1')[:n - 1].ljust(n, b'\0')


def build(stock_path, gltf_path, texture_path, out_path, name, texsize):
    stock = mdlread.Mdl(stock_path)
    d = stock.d
    ref = stock.pose()
    joints, prims = gltfload.load(gltf_path)
    verts, vbone, norms, nbone, cmds, ntris = body_mesh(retarget(joints, prims, stock, ref), ref, texsize)

    # Everything before the body parts (bones, controllers, attachments,
    # hitboxes, sequences, animations) is kept byte for byte; the body parts,
    # models, meshes and textures after it are written again.
    cut = stock.bodypartindex
    counts = struct.unpack_from('<26i', d, mdlread.HEADER)
    for index in (1, 3, 5, 7, 9, 19):
        if counts[index] > cut:
            raise ValueError(f'{stock_path}: unexpected layout')
    if any(s['animindex'] >= cut for s in stock.seqs.values()) or min(stock.texindex, stock.skinindex) < cut:
        raise ValueError(f'{stock_path}: unexpected layout')
    out = bytearray(d[:cut])

    def align():
        out.extend(b'\0' * (-len(out) % 4))

    def reserve(n):
        align()
        at = len(out)
        out.extend(b'\0' * n)
        return at

    def write_model(at, mname, mtype, radius, v, vb, n, nb, meshes):
        """meshes: (triangle commands, numtris, skinref, numnorms) each."""
        vi_off = reserve(len(vb)); out[vi_off:] = bytes(vb)
        ni_off = reserve(len(nb)); out[ni_off:] = bytes(nb)
        v_off = reserve(0); out.extend(np.asarray(v, '<f4').tobytes())
        n_off = reserve(0); out.extend(np.asarray(n, '<f4').tobytes())
        mesh_off = reserve(20 * len(meshes))
        for k, (tc, numtris, skinref, numnorms) in enumerate(meshes):
            tri_off = reserve(0)
            out.extend(tc)
            struct.pack_into('<5i', out, mesh_off + 20 * k, numtris, tri_off, skinref, numnorms, 0)
        struct.pack_into('<64sif10i', out, at, mname, mtype, radius, len(meshes), mesh_off,
                         len(v), vi_off, v_off, len(n), ni_off, n_off, 0, 0)

    bp_off = reserve(76 * stock.numbodyparts)
    for bp in range(stock.numbodyparts):
        o = stock.bodypartindex + bp * 76
        nmod, base, mi = struct.unpack_from('<3i', d, o + 64)
        models_off = reserve(112 * nmod)
        struct.pack_into('<64s3i', out, bp_off + 76 * bp, d[o:o + 64], nmod, base, models_off)
        for j in range(nmod):
            mo = mi + j * 112
            mname, mtype, radius = struct.unpack_from('<64sif', d, mo)
            if bp == 0 and j == 0:
                write_model(models_off, name_field(name, 64), mtype, radius, np.array(verts),
                            np.array(vbone, np.uint8), np.array(norms), np.array(nbone, np.uint8),
                            [(cmds, ntris, 0, len(norms))])
                continue
            nmesh, meshi, nv, vii, vi, nn, nii, ni = struct.unpack_from('<8i', d, mo + 72)
            meshes = []
            for k in range(nmesh):
                numtris, tri_off, skinref, numnorms, _ = struct.unpack_from('<5i', d, meshi + 20 * k)
                p = tri_off
                while (c := struct.unpack_from('<h', d, p)[0]) != 0:
                    p += 2 + 8 * abs(c)
                meshes.append((d[tri_off:p + 2], numtris, skinref, numnorms))
            write_model(models_off + 112 * j, mname, mtype, radius, np.frombuffer(d, '<f4', nv * 3, vi),
                        d[vii:vii + nv], np.frombuffer(d, '<f4', nn * 3, ni), d[nii:nii + nn], meshes)

    # Texture 0 (the body's skin) is replaced, the others are copied.
    tex_off = reserve(80 * stock.numtex)
    skin_off = reserve(0)
    out.extend(d[stock.skinindex:stock.skinindex + 2 * stock.numskinref * stock.numskinfam])
    texdata_off = reserve(0)
    for t in range(stock.numtex):
        tname, flags, w, h, idx = struct.unpack_from('<64s4i', d, stock.texindex + 80 * t)
        if t == 0:
            tname, w, h, data = name_field(name + '.bmp', 64), texsize, texsize, quantize(texture_path, texsize)
        else:
            data = d[idx:idx + w * h + 768]
        struct.pack_into('<64s4i', out, tex_off + 80 * t, tname, flags, w, h, reserve(0))
        out.extend(data)

    struct.pack_into('<i', out, 72, len(out))  # length
    struct.pack_into('<3i', out, mdlread.HEADER + 40, stock.numtex, tex_off, texdata_off)
    struct.pack_into('<i', out, mdlread.HEADER + 60, skin_off)
    struct.pack_into('<i', out, mdlread.HEADER + 68, bp_off)
    struct.pack_into('<i', out, mdlread.HEADER + 100, bp_off)  # transitionindex (no transitions)
    open(out_path, 'wb').write(out)

    # Read it back: the body must have every triangle, the rest must match the stock model.
    check = mdlread.Mdl(out_path)
    if len(check.model(0)[4]) != ntris or len(check.model(1, 1)[4]) != len(stock.model(1, 1)[4]) \
            or check.seqs != stock.seqs or check.textures[1]['name'] != stock.textures[1]['name']:
        raise ValueError(f'{out_path}: read back differs')
    print(f'gltf2mdl: {out_path}: {len(verts)} vertices, {len(norms)} normals, {ntris} triangles, {len(out)} bytes')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--stock', required=True, help='stock player model whose skeleton and animations are kept')
    ap.add_argument('--gltf', required=True, help='Mixamo-rigged character (Unity2Skfb glTF)')
    ap.add_argument('--texture', required=True, help="the character's texture (square image)")
    ap.add_argument('--name', required=True, help='model and texture name inside the file')
    ap.add_argument('--out', required=True)
    ap.add_argument('--texsize', type=int, default=512, help='texture size in the model (stock: 512)')
    a = ap.parse_args()
    build(a.stock, a.gltf, a.texture, a.out, a.name, a.texsize)
