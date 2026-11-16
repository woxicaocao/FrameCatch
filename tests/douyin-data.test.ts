import { describe, expect, it } from 'vitest';
import { douyinVideoId, parseDouyinDetail } from '../electron/douyin-data';

const id = '7704696872263034451';
const media = (name: string) => `https://v11-weba.douyinvod.com/video/${name}/?sig=SYNTHETIC`;
const bitrate = (name = 'complete', height = 1280, rate = 900000, format = 'mp4') => ({ format, bit_rate: rate, play_addr: { height, width: height * 9 / 16, url_list: [media(name)] } });
const detail = (tracks: unknown[] = [bitrate()]) => ({ aweme_detail: { aweme_id: id, desc: '测试作品', author: { nickname: '测试作者' }, video: { duration: 459220, bit_rate: tracks, cover: { url_list: ['https://image.example.test/cover.jpg'] } } } });

describe('抖音精确作品响应', () => {
  it('保持大整数作品ID为字符串，只接受真实抖音独立视频路径', () => {
    expect(douyinVideoId(`https://www.douyin.com/video/${id}?previous_page=share`)).toBe(id);
    for (const url of [`https://www.douyin.com.evil.test/video/${id}`, `http://www.douyin.com/video/${id}`, `https://www.douyin.com/video/${id}/other`, 'https://v.douyin.com/short/', 'https://www.douyin.com/video/1']) expect(() => douyinVideoId(url)).toThrow();
  });
  it('只匹配目标作品，拒绝推荐视频或已丢精度的数字ID', () => {
    expect(parseDouyinDetail(detail(), '7704614785010175270')).toBeUndefined();
    const numeric = detail(); (numeric.aweme_detail as any).aweme_id = Number(id);
    expect(parseDouyinDetail(numeric, id)).toBeUndefined();
  });
  it('只选完整mp4，分辨率优先而不是把DASH独立轨当完整视频', () => {
    const value = detail([bitrate('high-rate-low-res', 1024, 2000000), bitrate('complete-higher-res', 1280, 900000), bitrate('dash-higher-res', 1920, 3000000, 'dash')]);
    const parsed = parseDouyinDetail(value, id)!;
    expect(parsed.url).toBe(media('complete-higher-res'));
    expect(parsed.duration).toBe(459.22);
    expect(parsed.width).toBe(720); expect(parsed.height).toBe(1280);
    expect(parsed.uploader).toBe('测试作者');
  });
  it.each(['https://v11-weba.douyinvod.com/media-video-avc1/track.mp4', 'https://v11-weba.douyinvod.com/media-audio-und-mp4a/track.mp4', 'https://v11-weba.douyinvod.com/file.mp4?range=0-99', 'https://v11-weba.douyinvod.com/file.m4s'])('不使用独立轨、初始化或局部资源 %s', url => {
    const track = bitrate(); track.play_addr.url_list = [url];
    expect(parseDouyinDetail(detail([track]), id)).toBeUndefined();
  });
  it.each(['http://v11-weba.douyinvod.com/file.mp4', 'file:///C:/private.mp4', 'https://v11-weba.douyinvod.com.evil.test/file.mp4', 'https://u:p@v11-weba.douyinvod.com/file.mp4', 'https://127.0.0.1/private.mp4', 'https://v11-weba.douyinvod.com/file.mp4\n--exec cmd'])('拒绝不可信媒体地址 %s', url => {
    const track = bitrate(); track.play_addr.url_list = [url];
    expect(parseDouyinDetail(detail([track]), id)).toBeUndefined();
  });
  it('无完整资源、直播、超限数据不会返回看似可下载的作品', () => {
    expect(parseDouyinDetail(detail([]), id)).toBeUndefined();
    expect(parseDouyinDetail(detail(Array.from({ length: 129 }, () => bitrate())), id)).toBeUndefined();
    expect(parseDouyinDetail({ aweme_detail: { ...detail().aweme_detail, is_live: true } }, id)).toBeUndefined();
    expect(parseDouyinDetail(null, id)).toBeUndefined();
  });
  it('返回字段白名单，原始请求头、命令与脚本都不透传', () => {
    const value = Object.assign(detail(), { http_headers: { Cookie: 'DO_NOT_COPY' }, postprocessors: [{ key: 'Exec' }], _exec: 'cmd' });
    const parsed = parseDouyinDetail(value, id)!;
    expect(Object.keys(parsed).sort()).toEqual(['duration', 'height', 'id', 'thumbnail', 'title', 'uploader', 'url', 'width']);
    expect(JSON.stringify(parsed)).not.toContain('DO_NOT_COPY');
  });
});
