"""Reads a GoldSrc studio model (IDST version 10): header, bones, sequences'
animations, textures and a body part's mesh. Used by gltf2mdl.py,
preview.py and portrait.py."""
import struct

import numpy as np

HEADER = 140  # offset of the counts and indexes after id, version, name, length and the boxes


class Mdl:
    def __init__(self, path):
        self.d = d = open(path, 'rb').read()
        if d[:4] != b'IDST' or self.i(4) != 10:
            raise ValueError(f'{path}: not a GoldSrc studio model')
        (self.numbones, self.boneindex, _, _, _, _, self.numseq, self.seqindex, _, _,
         self.numtex, self.texindex, self.texdataindex, self.numskinref, self.numskinfam,
         self.skinindex, self.numbodyparts, self.bodypartindex) = struct.unpack_from('<18i', d, HEADER)
        self.bones = []
        for b in range(self.numbones):
            o = self.boneindex + b * 112
            self.bones.append(dict(name=self.s(o, 32), parent=self.i(o + 32),
                                   value=np.array(struct.unpack_from('<6f', d, o + 64)),
                                   scale=np.array(struct.unpack_from('<6f', d, o + 88))))
        self.seqs = {}
        for q in range(self.numseq):
            o = self.seqindex + q * 176
            self.seqs[self.s(o, 32)] = dict(numframes=self.i(o + 56), numblends=self.i(o + 120),
                                            animindex=self.i(o + 124))
        self.textures = []
        for t in range(self.numtex):
            o = self.texindex + t * 80
            w, h, idx = struct.unpack_from('<3i', d, o + 68)
            pix = np.frombuffer(d, np.uint8, w * h, idx).reshape(h, w)
            pal = np.frombuffer(d, np.uint8, 768, idx + w * h).reshape(256, 3)
            self.textures.append(dict(name=self.s(o, 64), w=w, h=h, rgb=pal[pix]))
        self.skinref = [struct.unpack_from('<h', d, self.skinindex + 2 * k)[0] for k in range(self.numskinref)]

    def i(self, o):
        return struct.unpack_from('<i', self.d, o)[0]

    def s(self, o, n):
        return self.d[o:o + n].split(b'\0')[0].decode('latin1')

    def model(self, bodypart, sub=0):
        """Vertices and normals (bone space) with their bones, and triangles
        as (skinref, ((vert, norm, s, t) x 3)) in the file's winding."""
        mo = self.i(self.bodypartindex + bodypart * 76 + 72) + sub * 112
        nmesh, meshi, nv, vii, vi, nn, nii, ni = struct.unpack_from('<8i', self.d, mo + 72)
        verts = np.frombuffer(self.d, '<f4', nv * 3, vi).reshape(-1, 3).astype(float)
        vbone = np.frombuffer(self.d, np.uint8, nv, vii)
        norms = np.frombuffer(self.d, '<f4', nn * 3, ni).reshape(-1, 3).astype(float)
        nbone = np.frombuffer(self.d, np.uint8, nn, nii)
        tris = []
        for m in range(nmesh):
            _, p, skinref = struct.unpack_from('<3i', self.d, meshi + m * 20)
            while True:
                c = struct.unpack_from('<h', self.d, p)[0]
                p += 2
                if c == 0:
                    break
                pts = [struct.unpack_from('<4h', self.d, p + 8 * k) for k in range(abs(c))]
                p += 8 * abs(c)
                for k in range(2, len(pts)):
                    if c < 0:  # fan
                        tris.append((skinref, (pts[0], pts[k - 1], pts[k])))
                    elif k % 2 == 0:  # strip
                        tris.append((skinref, (pts[k - 2], pts[k - 1], pts[k])))
                    else:
                        tris.append((skinref, (pts[k - 1], pts[k - 2], pts[k])))
        return verts, vbone, norms, nbone, tris

    def pose(self, seq=None, frame=0, blend=0):
        """Bone-to-model matrices (4x4) for a frame of one of a sequence's
        blends (stored one after another, 12 bytes per bone), or for the
        reference pose the mesh is bound in."""
        mats = []
        for b, bone in enumerate(self.bones):
            v = bone['value'].copy()
            if seq is not None:
                panim = self.seqs[seq]['animindex'] + (blend * self.numbones + b) * 12
                offs = struct.unpack_from('<6H', self.d, panim)
                for j in range(6):
                    if offs[j]:
                        v[j] += self.animvalue(panim + offs[j], frame) * bone['scale'][j]
            m = np.eye(4)
            m[:3, :3] = angle_matrix(v[3:])
            m[:3, 3] = v[:3]
            mats.append(mats[bone['parent']] @ m if bone['parent'] >= 0 else m)
        return np.stack(mats)

    def animvalue(self, p, k):
        # Run-length encoded: (valid, total) headers followed by valid values.
        while True:
            valid, total = self.d[p], self.d[p + 1]
            if total > k:
                break
            k -= total
            p += 2 * (valid + 1)
        return struct.unpack_from('<h', self.d, p + 2 * (k + 1 if valid > k else valid))[0]


def angle_matrix(a):
    """The engine's AngleQuaternion followed by QuaternionMatrix (radians)."""
    sr, cr = np.sin(a[0] / 2), np.cos(a[0] / 2)
    sp, cp = np.sin(a[1] / 2), np.cos(a[1] / 2)
    sy, cy = np.sin(a[2] / 2), np.cos(a[2] / 2)
    x = sr * cp * cy - cr * sp * sy
    y = cr * sp * cy + sr * cp * sy
    z = cr * cp * sy - sr * sp * cy
    w = cr * cp * cy + sr * sp * sy
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])
