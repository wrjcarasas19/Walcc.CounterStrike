"""Reads a skinned character from a glTF file: either as written by Sketchfab's
Unity exporter (Unity2Skfb: glTF 2.0 with glTF 1.0 skins, JOINT and WEIGHT
attributes, jointNames, bindShapeMatrix, Mixamo bone names), or plain glTF 2.0
skins (JOINTS_0, WEIGHTS_0, inverseBindMatrices) with a rig from RIGS naming
its bones. Returns the mesh in its rest pose, with texture coordinates whose
V runs top-down, and the Mixamo joints' world matrices."""
import json
import os
import re

import numpy as np

COMP = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


# Rig name -> {source bone: Mixamo bone}. Source bones lose a trailing _<number>
# (Sketchfab's node numbering); a bone not listed follows its nearest listed
# parent, or the hips if none is (the root and centre-of-mass bones).
RIGS = {
    # Multiversus characters (fml_un_*); Pickle Rick's own arms and legs are
    # the fml_un_pickle_* ones, the human ones carry no vertices of his.
    'multiversus-pickle': {
        'fml_un_C_pelvis': 'Hips',
        'fml_un_C_spine_a': 'Spine',
        'fml_un_C_spine_b': 'Spine1',
        'fml_un_C_spine_d': 'Spine2',
        'fml_un_C_neck_a': 'Neck',
        'fml_un_C_head': 'Head',
    },
}
for _side, _s in (('Left', 'L'), ('Right', 'R')):
    RIGS['multiversus-pickle'].update({
        f'fml_un_pickle_{_s}_clav': _side + 'Shoulder',
        f'fml_un_pickle_{_s}_uparm': _side + 'Arm',
        f'fml_un_pickle_{_s}_loarm': _side + 'ForeArm',
        f'fml_un_pickle_{_s}_wrist': _side + 'Hand',
        f'fml_un_pickle_{_s}_upleg': _side + 'UpLeg',
        f'fml_un_pickle_{_s}_loleg': _side + 'Leg',
        f'fml_un_pickle_{_s}_foot': _side + 'Foot',
        f'fml_un_pickle_{_s}_ball': _side + 'ToeBase',
    })


def load(path, rig=None):
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

    if rig:
        return load_rig(g, acc, nodes, parent, RIGS[rig])

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
            # Unity2Skfb keeps Unity's bottom-up V.
            uv = acc(at['TEXCOORD_0']).astype(float) * [1, -1] + [0, 1]
            prims.append(dict(pos=vw, nrm=nw, uv=uv,
                              joints=[[names[j] for j in row] for row in ji], weights=wt,
                              tris=acc(p['indices']).reshape(-1, 3).astype(int)))
    return joints, prims


def load_rig(g, acc, nodes, parent, rig):
    """Plain glTF 2.0 skins, in their bind pose: the vertices as stored and the
    joints at their inverse bind matrices' inverses, which skip whatever pose
    the nodes were left in."""
    def mapped(i):
        while i is not None:
            name = re.sub(r'_\d+$', '', nodes[i].get('name', ''))
            if name in rig:
                return rig[name]
            i = parent.get(i)
        return 'Hips'

    joints, prims = {}, []
    for n in nodes:
        if 'mesh' not in n:
            continue
        skin = g['skins'][n['skin']]
        ibm = acc(skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1).astype(float)
        names = []
        for k, j in enumerate(skin['joints']):
            names.append(mapped(j))
            if re.sub(r'_\d+$', '', nodes[j]['name']) in rig:
                joints[names[-1]] = np.linalg.inv(ibm[k])
        for p in g['meshes'][n['mesh']]['primitives']:
            at = p['attributes']
            nrm = acc(at['NORMAL']).astype(float)
            ji = acc(at['JOINTS_0']).astype(int)
            prims.append(dict(pos=acc(at['POSITION']).astype(float),
                              nrm=nrm / np.linalg.norm(nrm, axis=1, keepdims=True),
                              uv=acc(at['TEXCOORD_0']).astype(float),
                              joints=[[names[j] for j in row] for row in ji],
                              weights=acc(at['WEIGHTS_0']).astype(float),
                              tris=acc(p['indices']).reshape(-1, 3).astype(int)))
    return joints, prims
