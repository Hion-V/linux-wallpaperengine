#!/usr/bin/env python3
"""Render regression for composition bounds, child warps, and alpha.

Run in a graphical session: python3 tests/composition-layers.py ENGINE
Requires Pillow. Generates its own scene, shaders, and textures; no Steam assets.
"""
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time

from PIL import Image


def fixture(root, effects):
    def write(name, value):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) if not isinstance(value, str) else value)

    def texture(name, width, height, color):
        data = bytes(color) * width * height
        path = root / f'materials/{name}.tex'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'TEXV0005\0TEXI0001\0'
                         + struct.pack('<7I', 0, 2, width, height, width, height, 0)
                         + b'TEXB0003\0' + struct.pack('<3I', 1, 0xffffffff, 1)
                         + struct.pack('<5I', width, height, 0, len(data), len(data)) + data)

    vertex = '''uniform mat4 g_ModelViewProjectionMatrix;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
    gl_Position = g_ModelViewProjectionMatrix * vec4(a_Position, 1.0);
    v_TexCoord = a_TexCoord;
}'''
    fragment = '''uniform sampler2D g_Texture0;
varying vec2 v_TexCoord;
void main() { gl_FragColor = texture(g_Texture0, v_TexCoord); }'''
    write('shaders/plain.vert', vertex)
    write('shaders/plain.frag', fragment)
    write('shaders/shift.vert', vertex)
    write('shaders/shift.frag', fragment.replace('v_TexCoord);', 'v_TexCoord + vec2(0.125, 0.0));'))
    write('shaders/composelayer.vert', '''uniform mat4 g_ModelViewProjectionMatrix;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec3 v_ScreenCoord;
void main() {
    v_ScreenCoord = (g_ModelViewProjectionMatrix * vec4(a_Position, 1.0)).xyw;
    gl_Position = vec4(a_TexCoord * 2.0 - 1.0, 0.0, 1.0);
}''')
    write('shaders/composelayer.frag', '''uniform sampler2D g_Texture0;
varying vec3 v_ScreenCoord;
void main() {
    gl_FragColor = texture(g_Texture0, v_ScreenCoord.xy / v_ScreenCoord.z * 0.5 + 0.5);
}''')
    for name, shader, tex in [('background', 'plain', 'blue'), ('child', 'plain', 'green'),
                              ('group', 'composelayer', '_rt_FullFrameBuffer'), ('shift', 'shift', None)]:
        material = {'shader': shader, 'blending': 'translucent' if name != 'shift' else 'normal',
                    'depthtest': 'disabled', 'depthwrite': 'disabled', 'cullmode': 'nocull'}
        if tex:
            material['textures'] = [tex]
        write(f'materials/{name}.json', {'passes': [material]})
        write(f'models/{name}.json', {'material': f'materials/{name}.json', 'passthrough': name == 'group'})
    texture('blue', 320, 180, (0, 0, 255, 255))
    texture('green', 32, 24, (0, 255, 0, 128))
    write('effects/shift/effect.json', {'passes': [{'material': 'materials/shift.json'}]})
    write('project.json', {'file': 'scene.json', 'type': 'scene', 'title': 'Composition regression'})
    write('scene.json', {
        'camera': {'eye': '0 0 0', 'center': '0 0 -1', 'up': '0 1 0'},
        'general': {'orthogonalprojection': {'width': 320, 'height': 180}, 'bloom': False,
                    'nearz': 0.01, 'farz': 1000, 'clearcolor': '0 0 1', 'cameraparallax': False},
        'objects': [
            {'id': 1, 'name': 'background', 'image': 'models/background.json', 'origin': '160 90 0', 'size': '320 180'},
            {'id': 2, 'name': 'group', 'image': 'models/group.json', 'origin': '160 90 0', 'size': '128 160',
             'scale': '0.75 0.75 1',
             'copybackground': False, 'effects': [{'id': 4, 'file': 'effects/shift/effect.json'}] if effects else []},
            {'id': 3, 'name': 'child', 'parent': 2, 'image': 'models/child.json', 'origin': '0 0 0', 'size': '32 24'},
        ],
    })


def render(engine, root, width, height):
    screenshot = root / f'{width}x{height}.png'
    with (root / 'renderer.log').open('w') as log:
        process = subprocess.Popen([engine, '--window', f'0x0x{width}x{height}', '--silent',
                                    '--disable-mouse', '--disable-parallax', '--assets-dir', str(root),
                                    '--screenshot', str(screenshot), '--screenshot-delay', '5', str(root)],
                                   stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 20
            while True:
                assert process.poll() is None, (root / 'renderer.log').read_text()
                assert time.monotonic() < deadline, (root / 'renderer.log').read_text()
                try:
                    with Image.open(screenshot) as image:
                        return image.convert('RGB')
                except (FileNotFoundError, OSError):
                    pass
                time.sleep(0.1)
        finally:
            process.terminate()
            process.wait(timeout=10)


def main():
    for effects in [True, False]:
        with tempfile.TemporaryDirectory(prefix='lwe-composition-') as directory:
            root = Path(directory)
            fixture(root, effects)
            for width, height in [(1920, 1080), (3840, 2160)]:
                image = render(sys.argv[1], root, width, height)
                center = 148 if effects else 160
                pixel = image.getpixel((int(center * width / 320), height // 2))
                assert pixel[0] < 4 and 120 <= pixel[1] <= 136 and 119 <= pixel[2] <= 136, pixel
                # The old child position must now show only the blue background.
                if effects:
                    pixel = image.getpixel((int(169 * width / 320), height // 2))
                    assert pixel[1] < 4 and pixel[2] > 250, pixel
                print(f'PASS: {width}x{height}, effects={effects}, child position and alpha')


if __name__ == '__main__':
    main()
