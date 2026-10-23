"""Reads a skinned character from a glTF file as written by Sketchfab's Unity
exporter (Unity2Skfb): glTF 2.0 with glTF 1.0 skins (JOINT and WEIGHT
attributes, jointNames, bindShapeMatrix). Returns the mesh in its rest pose
and the Mixamo joints' world matrices."""
import json
import os

import numpy as np

COMP = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load(path):
    g = json.load(open(path))
    buf = open(os.path.join(os.path.dirname(path), g['buffers'][0]['uri']), 'rb').read()

    def acc(i):
        a = g['accessors'][i]
        bv = g['bufferViews'][a['bufferView']]
        n = NCOMP[a['type']]
        dt = np.dtype('<' + COMP[a['componentType']])
        stride = bv.get('byteStride') or dt.itemsize * n
        off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        return np.stack([np.frombuffer(buf, dt, n, off + k * stride) for k in range(a['count'])])

    nodes = g['nodes']
    parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}

    def local(n):
        if 'matrix' in n:
            return np.array(n['matrix'], dtype=float).reshape(4, 4).T
        m = np.eye(4)
        if 'rotation' in n:
            x, y, z, w = n['rotation']
            m[:3, :3] = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
        if 'scale' in n:
            m[:3, :3] = m[:3, :3] @ np.diag(n['scale'])
        if 'translation' in n:
            m[:3, 3] = n['translation']
        return m

    world = {}

    def W(i):
        if i not in world:
            world[i] = (W(parent[i]) if i in parent else np.eye(4)) @ local(nodes[i])
        return world[i]

    def bone(nodename):
        # node_mixamorig:LeftArm_-2700 -> LeftArm
        return nodename.split('mixamorig:')[1].rsplit('_-', 1)[0]

    byname = {n['name']: i for i, n in enumerate(nodes)}
    joints = {bone(n['name']): W(i) for i, n in enumerate(nodes) if 'mixamorig:' in n['name']}

    prims = []
    for i, n in enumerate(nodes):
        if 'mesh' not in n:
            continue
        skin = g['skins'][n['skin']]
        ibm = acc(skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1).astype(float)
        bsm = np.array(skin['bindShapeMatrix'], dtype=float).reshape(4, 4).T
        names = [bone(j) for j in skin['jointNames']]
        # Unity2Skfb writes inverse bind matrices of the joints' world
        # transforms and leaves the mesh node's own transform out of
        # bindShapeMatrix, so it goes in here.
        mats = np.stack([W(byname[j]) @ ibm[k] @ W(i) @ bsm for k, j in enumerate(skin['jointNames'])])
        for p in g['meshes'][n['mesh']]['primitives']:
            at = p['attributes']
            pos = acc(at['POSITION']).astype(float)
            nrm = acc(at['NORMAL']).astype(float)
            ji = acc(at['JOINT']).astype(int)
            wt = acc(at['WEIGHT']).astype(float)
            ph = np.c_[pos, np.ones(len(pos))]
            vw = np.zeros((len(pos), 3))
            nw = np.zeros((len(pos), 3))
            for k in range(4):
                m = mats[ji[:, k]]
                vw += wt[:, k:k + 1] * np.einsum('nij,nj->ni', m, ph)[:, :3]
                nw += wt[:, k:k + 1] * np.einsum('nij,nj->ni', m[:, :3, :3], nrm)
            nw /= np.linalg.norm(nw, axis=1, keepdims=True)
            prims.append(dict(pos=vw, nrm=nw, uv=acc(at['TEXCOORD_0']).astype(float),
                              joints=[[names[j] for j in row] for row in ji], weights=wt,
                              tris=acc(p['indices']).reshape(-1, 3).astype(int)))
    return joints, prims
