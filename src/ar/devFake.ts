// 開発用：画像をカメラ映像の代わりに流す（本番のビルドには含まれない）
//   ?fake=<画像>                         … 画像をそのまま流す
//   ?fake=<画像>&photo=方位,仰角,傾き,横の画角 &vfov=<仮想カメラの横の画角>&vsize=幅x高さ
//                                        … 画像（正解の姿勢つき）から、センサーの向きに合わせて回した仮想カメラの映像を作る。
//                                          真の姿勢 = センサー姿勢 + truecorr（方位,仰角,傾きのくせ。既定 0,0,0）
import { basis, project, unproject, type CameraParams } from '../photo/camera';
import type { Pose } from './pose';

export async function fakeStream(params: URLSearchParams, truePose: (bias: Pose) => Pose | null): Promise<MediaStream> {
  const img = new Image();
  img.src = params.get('fake')!;
  await new Promise((r) => (img.onload = r));
  const photo = params.get('photo')?.split(',').map(Number);
  const out = document.createElement('canvas');
  if (!photo) {
    out.width = img.naturalWidth;
    out.height = img.naturalHeight;
    const draw = () => out.getContext('2d')!.drawImage(img, 0, 0);
    draw();
    setInterval(draw, 200);
    return out.captureStream(5);
  }
  // 元画像（幅 1600 に縮小）
  const sw = Math.min(1600, img.naturalWidth);
  const sh = Math.round((img.naturalHeight * sw) / img.naturalWidth);
  const sc = document.createElement('canvas');
  sc.width = sw;
  sc.height = sh;
  const sg = sc.getContext('2d', { willReadFrequently: true })!;
  sg.drawImage(img, 0, 0, sw, sh);
  const src = sg.getImageData(0, 0, sw, sh).data;
  const [py, pp, pr, phf] = photo;
  const srcCam: CameraParams = { yaw: py, pitch: pp, roll: pr, focalPx: sw / 2 / Math.tan((phf * Math.PI) / 360), width: sw, height: sh };
  const bs = basis(py, pp, pr);
  const [vw, vh] = (params.get('vsize') ?? '640x480').split('x').map(Number);
  const vfov = Number(params.get('vfov') ?? phf / 2);
  const tc = (params.get('truecorr') ?? '0,0,0').split(',').map(Number);
  out.width = vw;
  out.height = vh;
  const og = out.getContext('2d')!;
  const od = og.createImageData(vw, vh);
  const draw = () => {
    const pose = truePose({ yaw: tc[0], pitch: tc[1], roll: tc[2] });
    if (!pose) return;
    const cam: CameraParams = { ...pose, focalPx: vw / 2 / Math.tan((vfov * Math.PI) / 360), width: vw, height: vh };
    const bd = basis(pose.yaw, pose.pitch, pose.roll);
    const d = od.data;
    for (let y = 0; y < vh; y++)
      for (let x = 0; x < vw; x++) {
        const p = project(srcCam, bs, unproject(cam, bd, x + 0.5, y + 0.5));
        const o = (y * vw + x) * 4;
        d[o + 3] = 255;
        const xi = p ? Math.floor(p[0]) : -1;
        const yi = p ? Math.floor(p[1]) : -1;
        if (xi < 0 || yi < 0 || xi >= sw || yi >= sh) {
          d[o] = d[o + 1] = d[o + 2] = 0;
          continue;
        }
        const i = (yi * sw + xi) * 4;
        d[o] = src[i];
        d[o + 1] = src[i + 1];
        d[o + 2] = src[i + 2];
      }
    og.putImageData(od, 0, 0);
  };
  draw();
  setInterval(draw, 200);
  return out.captureStream(5);
}
