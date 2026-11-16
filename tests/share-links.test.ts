import { describe, expect, it } from 'vitest';
import { normalizeShareLink } from '../electron/share-links';

describe('抖音与视频号分享输入', () => {
  it('识别用户完整口令及转义链接，不把作品ID转成Number', () => {
    const text = '3.35 复制打开抖音，看看【八道的作品】没想到中国短剧在国外热度这么高 # 短剧出海 https\\://v.douyin.com/nb0IbhnzrDM/ 11/16 Mwf:/ Y@M.jc :5pm';
    expect(normalizeShareLink(text)).toEqual({ platform: 'douyin', url: 'https://v.douyin.com/nb0IbhnzrDM/' });
    expect(normalizeShareLink('https://www.douyin.com/jingxuan?modal_id=7704614785010175270')).toEqual({ platform: 'douyin', url: 'https://www.douyin.com/video/7704614785010175270' });
    expect(normalizeShareLink('https://www.iesdouyin.com/share/video/7704614785010175270/?utm=source')).toEqual({ platform: 'douyin', url: 'https://www.douyin.com/video/7704614785010175270' });
  });
  it('识别用户视频号短链、Markdown及中文包围符，保留区分大小写的令牌', () => {
    expect(normalizeShareLink('视频号“https://weixin.qq.com/sph/APs1aO2qFw”。')).toEqual({ platform: 'wechat-channels', url: 'https://weixin.qq.com/sph/APs1aO2qFw' });
    const url = 'https://www.douyin.com/jingxuan?modal_id=7704614785010175270';
    expect(normalizeShareLink(`[${url}](${url})`).url).toBe('https://www.douyin.com/video/7704614785010175270');
  });
  it.each(['', '只有复制口令没有链接', 'https://douyin.com.evil.test/video/7704614785010175270', 'https://www.douyin.com@evil.test/video/7704614785010175270', 'file:///C:/private.txt', 'https://www.douyin.com:1234/video/7704614785010175270', 'https://weixin.qq.com/s/公众号文章', 'https://www.douyin.com/user/abc', 'https://www.douyin.com/jingxuan?modal_id=NaN', 'https://www.douyin.com/video/7704614785010175270?modal_id=7704614785010175271', 'https://www.douyin.com/jingxuan?modal_id=7704614785010175270&modal_id=7704614785010175271', 'https://v.douyin.com/abc/\u0000', 'https://v.douyin.com/abc/\u202e'])('无效/不支持输入不产生网络解析：%s', text => {
    expect(() => normalizeShareLink(text)).toThrow();
  });
  it('多条不同作品拒绝；普通文案只作为数据，不执行其中的命令', () => {
    expect(() => normalizeShareLink('https://v.douyin.com/one/ https://weixin.qq.com/sph/two')).toThrow('多条');
    expect(normalizeShareLink('$(do-not-run) https://v.douyin.com/abc/ ; echo ignored')).toEqual({ platform: 'douyin', url: 'https://v.douyin.com/abc/' });
  });
});
