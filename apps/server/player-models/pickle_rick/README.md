# Pickle Rick

"Pickle Rick Multiversus" by Antouss
(https://sketchfab.com/3d-models/pickle-rick-multiversus-b9c6adb18b204342874e445239e127f1),
licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

Files, from the Sketchfab download (glTF):

- `pickle_rick.gltf`, `pickle_rick.bin`: `scene.gltf` and `scene.bin` cut down
  to the body mesh (`Object_0`, material `C020_S01_Base_MIC`), its skin and the
  nodes. Left out: the animation, the outline shells (`OH_Outline_Material`),
  the rat mask and the mustard bottle, which the player model doesn't use.
  Vertices, skin and node transforms are unchanged.
- `C020_S01_Base_MIC_baseColor.png`: the body's texture, unchanged, from `textures/`

Changes in the image: `../gltf2mdl.py` simplifies the mesh to about 10,000
triangles (the browser's renderer draws at most 16,384 strip vertices per
model), puts it on the stock Counter-Strike GSG-9 skeleton
(`models/player/gsg9/gsg9.mdl`) and its animations through the `fml_un_pickle_*`
bones (`multiversus-pickle` in `../gltfload.py`), binds each vertex to a single
bone, draws the head at 0.6 of its height so the top of the pickle stays near
the stock head hitbox, and reduces the texture to 512×512 pixels and 256 colours.

Rick and Morty and its characters belong to Adult Swim / Warner Bros. Discovery.
