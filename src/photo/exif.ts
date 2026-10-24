import exifr from 'exifr';

export interface PhotoMeta {
  lat?: number;
  lon?: number;
  gpsAlt?: number;
  focal35?: number;
  focal?: number;
  /** 撮影方位 [deg] と基準（T=真北, M=磁北） */
  direction?: number;
  directionRef?: string;
  date?: Date;
  model?: string;
}

/** EXIF を読む（ファイルはブラウザ内で読むだけで、外部には送信しない） */
export async function readPhotoMeta(file: File): Promise<PhotoMeta> {
  try {
    const t = await exifr.parse(file, { tiff: true, exif: true, gps: true, xmp: false, icc: false, iptc: false });
    if (!t) return {};
    return {
      lat: typeof t.latitude === 'number' ? t.latitude : undefined,
      lon: typeof t.longitude === 'number' ? t.longitude : undefined,
      gpsAlt: typeof t.GPSAltitude === 'number' ? t.GPSAltitude : undefined,
      focal35: t.FocalLengthIn35mmFormat || undefined,
      focal: t.FocalLength || undefined,
      direction: typeof t.GPSImgDirection === 'number' ? t.GPSImgDirection : undefined,
      directionRef: t.GPSImgDirectionRef,
      date: t.DateTimeOriginal instanceof Date ? t.DateTimeOriginal : undefined,
      model: [t.Make, t.Model].filter(Boolean).join(' ') || undefined,
    };
  } catch {
    return {};
  }
}
