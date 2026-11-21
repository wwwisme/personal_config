// ============================================================================
// GLaDOS 风格 全局扩展脚本 (Global Extend Script) for Clash Verge Rev
// ----------------------------------------------------------------------------
// 作用：把任意机场订阅（节点/分组/规则）统一改造成 GLaDOS 官网配置的风格：
//   - 依据节点名识别地区 (US / TW / JP / HK / SG / KR ...)
//   - 为每个地区生成 load-balance Balancer 与 Fixed IP fallback 分组
//   - 生成 Default Proxy / Auto / Streaming 等核心分组
//   - 生成业务分组 (Google/OpenAI/Claude/SpaceX/Microsoft/Steam/Download)
//   - 套用 GLaDOS 风格规则 (本地 DIRECT → 业务分流 → GEOIP,CN → MATCH)
//   - 合并订阅自带规则：原规则置顶优先，目标(分组名)不存在时改写为 Default Proxy
//
// 使用方法：Clash Verge Rev -> 订阅 -> 全局扩展脚本 -> 选择本文件
// 入口必须是 main(config, profileName)，返回修改后的 config 对象。
// ============================================================================

// 地区关键词 => 分组里使用的地区代号。node.name 命中即归入对应地区。
// 命中顺序即数组顺序，越靠前权重越高。
// 命中用函数判断：入参是 name 的小写形式，返回 true 即命中。
// 统一用「非字母数字」作为分隔符（含空格 / - / _ / . / 数字 与行首），
// 这样 US01、us 01、US-Silicon、🇺🇸us 都能正确识别，又不会误判 focus(/cus/…) 之类。
const REGION_RULES = [
  { code: 'US', test: function (s) { return /(^|[^a-z0-9])(us|usa|unitedstates|american)([^a-z]|$)/i.test(s) || s.indexOf('美') >= 0; } },
  { code: 'TW', test: function (s) { return /(^|[^a-z0-9])(tw|taiwan)([^a-z]|$)/i.test(s) || s.indexOf('台湾') >= 0 || s.indexOf('台') >= 0; } },
  { code: 'JP', test: function (s) { return /(^|[^a-z0-9])(jp|japan)([^a-z]|$)/i.test(s) || s.indexOf('日本') >= 0 || s.indexOf('日') >= 0; } },
  { code: 'HK', test: function (s) { return /(^|[^a-z0-9])(hk|hong(king|kong)|hk$)([^a-z]|$)/i.test(s) || s.indexOf('香港') >= 0; } },
  { code: 'SG', test: function (s) { return /(^|[^a-z0-9])(sg|singapore)([^a-z]|$)/i.test(s) || s.indexOf('新加坡') >= 0; } },
  { code: 'KR', test: function (s) { return /(^|[^a-z0-9])(kr|korea)([^a-z]|$)/i.test(s) || s.indexOf('韩') >= 0; } },
  { code: 'UK', test: function (s) { return /(^|[^a-z0-9])(uk|unitedkingdom)([^a-z]|$)/i.test(s) || s.indexOf('英') >= 0; } },
  { code: 'DE', test: function (s) { return /(^|[^a-z0-9])(de|germany)([^a-z]|$)/i.test(s) || s.indexOf('德') >= 0; } },
  { code: 'FR', test: function (s) { return /(^|[^a-z0-9])(fr|france)([^a-z]|$)/i.test(s) || s.indexOf('法') >= 0; } },
];

// 需要被识别为「流媒体」节点的关键词，用于 Streaming 分组
const STREAM_KEYWORDS = [
  /stream|media|netflix|netflix|disney|hbo|prime|spotify|youtube|nf$/,
  '流媒体', '解锁', '奈飞',
];

// 加速/测速节点关键词，归入 Auto 分组的候选（命中则进入 Auto）
const AUTO_KEYWORDS = [
  /fast|auto|speed|smart|accel|premium|gamer/i,
  '加速', '测速', '智能',
];

// 选路 URL
const TEST_URL = 'http://www.gstatic.com/generate_204';

// ============================================================================
function main(config, profileName) {
  if (!config || typeof config !== 'object') config = {};

  // ---------- 1. 保底配置 ----------
  if (!config['mixed-port'] && !config['port'] && !config['socks-port']) {
    config['mixed-port'] = 7890;
  }
  config.mode = config.mode || 'rule';
  config['allow-lan'] = config['allow-lan'] || false;

  // ---------- 2. GLaDOS 风格 DNS (fake-ip + 国内 DoH) ----------
  config.dns = {
    enable: true,
    ipv6: true,
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    nameserver: [
      '119.29.29.29', '114.114.114.114', '223.5.5.5',
      'https://223.5.5.5/dns-query',
      'https://dns.alidns.com/dns-query',
      'https://doh.pub/dns-query',
    ],
    'default-nameserver': ['119.29.29.29', '114.114.114.114', '223.5.5.5'],
    'fake-ip-filter': [
      '*.lan', '*.local', '+.local', '*', '+.msftconnecttest.com',
      '+.msftncsi.com', '+.miwifi.com', '+.docker.io', '+.market.xiaomi.com',
      '+.push.apple.com', '+.cn',
    ],
  };

  // ---------- 3. 解析节点，按地区归类 ----------
  const proxies = Array.isArray(config.proxies) ? config.proxies : [];
  const filtered = proxies.filter(function (p) {
    return p && typeof p === 'object' && p.name && p.type;
  });

  // proxies 中去掉不需要的辅助组 (url-test / fallback / load-balance)，
  // 只保留真正的出站节点，避免分组嵌套 vless/vmess/ss/ssr/trojan/...
  const LEAF_TYPES = ['ss', 'vmess', 'trojan', 'vless', 'hysteria', 'hysteria2', 'hy2', 'tuic', 'snell', 'anytls', 'ssr', 'sel', 'socks5', 'http', 'wireguard', 'shadowsocks'];
  const leaves = filtered.filter(function (p) {
    return LEAF_TYPES.indexOf(String(p.type).toLowerCase()) >= 0;
  });

  const byRegion = {};   // code -> [node...]
  const autoList = [];   // 候选进入 Auto 的节点
  const streamList = []; // 候选进入 Streaming 的节点
  const usedNames = {};

  function uniqueName(raw) {
    var n = raw;
    var i = 1;
    while (usedNames[n]) { n = raw + '-' + (i++); }
    usedNames[n] = true;
    return n;
  }

  leaves.forEach(function (p) {
    var name = p.name || 'Node';
    var lower = name.toLowerCase();

    // 地区归属
    // 注：name 保留原始大小写用于匹配，避免小写化破坏 🇺🇸 等 emoji 前的判断
    var region = null;
    for (var r = 0; r < REGION_RULES.length && !region; r++) {
      if (REGION_RULES[r].test(name)) region = REGION_RULES[r].code;
    }

    if (!region) region = 'HK'; // 无法识别时默认归入 HK 附近以免误用（可自行调整）

    if (!byRegion[region]) byRegion[region] = [];
    p.name = uniqueName(p.name);   // 统一节点命名，防重名
    byRegion[region].push(p);

    // 流媒体 / 加速候选
    var isStream = STREAM_KEYWORDS.some(function (k) {
      return typeof k === 'string' ? lower.indexOf(k) >= 0 : k.test(lower);
    });
    var isAuto = AUTO_KEYWORDS.some(function (k) {
      return typeof k === 'string' ? lower.indexOf(k) >= 0 : k.test(lower);
    });
    if (isStream) streamList.push(p.name);
    else if (isAuto) autoList.push(p.name);
  });

  // 若流媒体候选为空，退化为全部节点
  if (streamList.length === 0) streamList.push.apply(streamList, leaves.map(function (p) { return p.name; }));

  // ---------- 4. 构造代理组 ----------
  const regionCodes = Object.keys(byRegion).sort();
  const allNames = leaves.map(function (p) { return p.name; });

  function groupDigest(r) { return byRegion[r].map(function (p) { return p.name; }); }
  function balancer(r) { return r + '-Balancer'; }
  function fixed(r) { return r + ' Fixed IP'; }

  // 拥有 Balancer 的地区（节点数 > 1）
  const multiRegions = regionCodes.filter(function (r) { return byRegion[r].length > 1; });
  // 所有实际存在的地区组名（Fixed IP + 有 Balancer 地区的 Balancer）
  const createdRegionGroups = [];
  regionCodes.forEach(function (r) {
    createdRegionGroups.push(fixed(r));
    if (multiRegions.indexOf(r) >= 0) createdRegionGroups.push(balancer(r));
  });

  var newGroups = [];

  // 4.1 Default Proxy —— select，多个核心组 + 各地区 fallback/balancer + 所有节点
  const defaultSelectors = [];
  defaultSelectors.push('Auto');
  defaultSelectors.push('Streaming');
  createdRegionGroups.forEach(function (g) { defaultSelectors.push(g); });
  defaultSelectors.push.apply(defaultSelectors, allNames);

  newGroups.push({
    name: 'Default Proxy',
    type: 'select',
    proxies: defaultSelectors,
  });

  // 4.2 Auto —— url-test，加速候选 + 各个地区的 Balancer（贴合 GLaDOS：测速挑最快）
  const autoProxies = [];
  multiRegions.forEach(function (r) { autoProxies.push(balancer(r)); });
  autoList.forEach(function (n) { autoProxies.push(n); });
  if (autoProxies.length === 0) autoProxies.push.apply(autoProxies, allNames);

  newGroups.push({
    name: 'Auto',
    type: 'url-test',
    url: TEST_URL,
    interval: 180,
    tolerance: 100,
    hidden: true,
    proxies: autoProxies,
  });

  // 4.3 Streaming —— select 流媒体节点
  const streamProxies = streamList.concat(multiRegions.map(balancer));
  newGroups.push({
    name: 'Streaming',
    type: 'select',
    // 无流媒体候选时退化为全部节点
    proxies: streamList.length ? streamProxies : allNames.slice(),
  });

  // 4.4 各地区：Balancer (consistent-hashing) + Fixed IP (fallback)
  regionCodes.forEach(function (r) {
    if (byRegion[r].length > 1) {
      newGroups.push({
        name: balancer(r),
        type: 'load-balance',
        url: TEST_URL,
        interval: 300,
        strategy: 'consistent-hashing',
        hidden: true,
        proxies: groupDigest(r),
      });
      newGroups.push({
        name: fixed(r),
        type: 'fallback',
        url: TEST_URL,
        interval: 300,
        proxies: groupDigest(r),
      });
    } else {
      // 单节点地区无 balancer，Fixed 直接指向它
      newGroups.push({
        name: fixed(r),
        type: 'select',
        proxies: groupDigest(r),
      });
    }
  });

  // 4.5 业务分组 (select)，顺序贴合 GLaDOS
  function serviceGroup(name, prios) {
    // 去重保留顺序，过滤掉空引用
    var seen = {};
    var out = [];
    (prios || []).forEach(function (g) { if (!seen[g] && g) { seen[g] = true; out.push(g); } });
    // 兜底：若无有效成员(mihomo 不接受空 proxies)，退化为选全部节点
    if (out.length === 0) out = allNames.slice();
    return { name: name, type: 'select', proxies: out };
  }

  // 仅收集实际存在（已创建）的地区组名
  const balAll = createdRegionGroups.filter(function (g) { return /-Balancer$/.test(g); });
  const svcPrio = createdRegionGroups.slice();            // Fixed IP + Balancer（已创建）
  const svcPrioWithDefault = ['Default Proxy'].concat(svcPrio).concat(['Auto']);

  // 流媒体 / 下载专用地区：优先 US，其次任一多节点地区，最后全部节点
  const dlRegion = (byRegion['US'] && byRegion['US'].length > 1) ? 'US'
                 : (multiRegions[0] || regionCodes[0] || 'US');
  const dlNames = (byRegion[dlRegion] || []).map(function (p) { return p.name; });
  if (dlNames.length === 0) dlNames.push.apply(dlNames, allNames);

  const groupMap = {};
  groupMap['Google']    = serviceGroup('Google',    (byRegion['US'] ? ['US Fixed IP'] : []).concat(svcPrio).concat(['Auto']));
  groupMap['OpenAI']    = serviceGroup('OpenAI',    (byRegion['US'] ? ['US Fixed IP'] : []).concat(svcPrio).concat(['Auto']));
  groupMap['Claude']    = serviceGroup('Claude',    (byRegion['US'] ? ['US Fixed IP'] : []).concat(svcPrio).concat(['Auto']));
  groupMap['SpaceX']    = serviceGroup('SpaceX',    svcPrioWithDefault);
  groupMap['Microsoft'] = serviceGroup('Microsoft', svcPrioWithDefault.concat(['DIRECT']));
  groupMap['Download']  = { name: 'Download', type: 'load-balance', url: TEST_URL, interval: 300, strategy: 'consistent-hashing', hidden: true, proxies: dlNames.length ? dlNames.slice(0, 8) : [] };
  groupMap['Steam']     = serviceGroup('Steam',    ['DIRECT', 'Download'].concat(balAll));

  // 其它 AI / 学术类优先走 US-Balancer；US 无 balancer 时不引用，退回首地区已建组或 Auto
  const academicPrio = [];
  if (balAll.indexOf(balancer('US')) >= 0) academicPrio.push(balancer('US'));   // US-Balancer 存在才引用
  balAll.forEach(function (g) { if (g !== balancer('US')) academicPrio.push(g); });
  academicPrio.push('Auto');
  groupMap['AI'] = serviceGroup('AI', academicPrio);

  // 收集业务分组（稳定顺序）
  ['Google', 'OpenAI', 'Claude', 'SpaceX', 'Microsoft', 'Steam', 'Download', 'AI'].forEach(function (k) {
    if (groupMap[k]) newGroups.push(groupMap[k]);
  });

  // ---------- 5. 生成规则 (GLaDOS 风格) ----------
  const rules = [];
  function P(domain, group) { rules.push('DOMAIN-SUFFIX,' + domain + ',' + group); }
  function K(key, group) { rules.push('DOMAIN-KEYWORD,' + key + ',' + group); }

  // 合并订阅自带的规则（放在 GLaDOS 规则之前，优先命中）。
  // 目标(最后字段)是旧分组名且新分组里不存在时，统一改写成 Default Proxy。
  // 跳过 MATCH（由我们兜底）和依赖 rule-providers 的规则（providers 会被删除）。
  var newGroupNames = newGroups.map(function (g) { return g.name; });
  var keepGroup = function (n) { return newGroupNames.indexOf(n) >= 0; };
  var skipPrefixes = ['RULE-SET', 'AND,', 'OR,', 'MATCH'];
  var mergedUserRules = [];
  var oldRules = Array.isArray(config.rules) ? config.rules : [];
  var builtinActions = { 'DIRECT': 1, 'REJECT': 1, 'REJECT-DROP': 1, 'REJECT-DROP,': 1, 'PASS': 1 };
  oldRules.forEach(function (line) {
    if (typeof line !== 'string') return;
    var s = line.trim();
    if (!s) return;
    // 跳过注释
    if (s.charAt(0) === '#') { mergedUserRules.push(line); return; }
    var skip = skipPrefixes.some(function (p) { return s.indexOf(p) === 0; });
    if (skip) return;
    var parts = s.split(',');
    // 规则格式：TYPE,value,group[,no-resolve]
    // 「目标分组」在最后一个字段；若末字段是 no-resolve / no_resolve 修饰符，
    // 则分组在倒数第二个字段，且修饰符必须保留（不能把它当作分组改写）。
    var modifier = null;
    var last = parts[parts.length - 1].trim();
    if (last === 'no-resolve' || last === 'no_resolve') {
      modifier = last;
      parts.pop();
    }
    var action = parts[parts.length - 1].trim();
    if (builtinActions[action]) { mergedUserRules.push(line); return; }
    // 其它目标：若为旧分组名且已不存在，则改写为 Default Proxy
    if (!keepGroup(action)) {
      parts[parts.length - 1] = 'Default Proxy';
      if (modifier) parts.push(modifier);
      mergedUserRules.push(parts.join(','));
    } else {
      mergedUserRules.push(line);
    }
  });
  // 置顶用户自定义规则，并去重(同 action+pattern 只留一条)
  mergedUserRules = mergedUserRules.filter(function (r, i) { return mergedUserRules.indexOf(r) === i; });

  // 本地 / 路由器 / 内部直连
  ['localhost', 'localhost.localdomain', 'local', '.internal', '.intranet', '.corp', '.private',
    'router.asus.com', 'tplinkwifi.net', 'miwifi.com', 'my.router', 'fritz.box',
    'myrouter.local', 'synology.me', '.test', '.example', '.invalid', '.localhost',
    '.dev.local', '.test.local'].forEach(function (d) { P(d, 'DIRECT'); });
  K('.local', 'DIRECT'); K('localhost', 'DIRECT');

  // IP 探测
  ['ipinfo.io', 'ip-api.com', 'ipify.org', 'icanhazip.com', 'ifconfig.me', 'ifconfig.co',
    'checkip.amazonaws.com', 'ipecho.net', 'myip.com', 'whatismyip.com', 'whatismyipaddress.com',
    'whoer.net', 'ipleak.net', 'ip.sb', 'ip.gs', 'ip138.com', 'speedtest.net', 'fast.com'].forEach(function (d) { P(d, 'Default Proxy'); });

  // 聊天 / 通讯
  ['telegram.org', 't.me', 'telegram.me', 'telegra.ph', 'telesco.pe', 'discord.com', 'discord.gg',
    'discordapp.com', 'discord.media', 'whatsapp.com', 'whatsapp.net', 'wa.me'].forEach(function (d) { P(d, 'Default Proxy'); });
  K('telegram', 'Default Proxy'); K('discord', 'Default Proxy');

  // 社交 (SpaceX 风格)
  ['twitter.com', 'x.com', 'twimg.com', 't.co', 'x.ai', 'spacex.com', 'starlink.com', 'tesla.com'].forEach(function (d) { P(d, 'SpaceX'); });
  K('twitter', 'SpaceX');
  ['facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com', 'reddit.com', 'redditmedia.com'].forEach(function (d) { P(d, 'Default Proxy'); });
  K('instagram', 'Default Proxy');

  // 模型 / AI / 下载走 Download
  ['huggingface.co', 'cdn-lfs.huggingface.co', 'hf.co', 's3.amazonaws.com', 'civitai.com',
    'replicate.com', 'wandb.ai', 'storage.googleapis.com', 'download.pytorch.org', 'ollama.ai', 'ollama.com'].forEach(function (d) { P(d, 'Download'); });

  // 游戏平台
  ['steampowered.com', 'steamgames.com', 'steamcommunity.com', 'steamstatic.com',
    'steamcontent.com', 's.team', 'epicgames.com', 'unrealengine.com', 'fortnite.com'].forEach(function (d) { P(d, 'Steam'); });
  K('steamcontent', 'Steam'); K('steampowered', 'Steam');

  // 搜索引擎 / AI 服务
  P('gemini.google.com', 'Google'); P('google.com', 'Google'); P('googleapis.com', 'Google');
  P('gstatic.com', 'Google'); P('gmail.com', 'Google'); P('play.google.com', 'Google');
  P('youtube.com', 'Streaming'); P('ytimg.com', 'Streaming'); P('googlevideo.com', 'Streaming');
  P('youtu.be', 'Streaming'); K('youtube', 'Streaming'); K('google', 'Google');

  // OpenAI / Claude
  P('chatgpt.com', 'OpenAI'); P('openai.com', 'OpenAI'); P('oaistatic.com', 'OpenAI'); P('oaiusercontent.com', 'OpenAI'); K('openai', 'OpenAI');
  P('claude.ai', 'Claude'); P('anthropic.com', 'Claude'); P('claude.com', 'Claude'); P('claudeusercontent.com', 'Claude'); K('claude', 'Claude');

  // 其它 AI / 学术 -> AI 分组
  ['perplexity.ai', 'mistral.ai', 'cohere.com', 'groq.com', 'cursor.com', 'cursor.sh',
    'together.ai', 'midjourney.com', 'poe.com', 'character.ai', 'arxiv.org', 'sciencedirect.com',
    'nature.com', 'openreview.net', 'paperswithcode.com', 'scholar.google.com'].forEach(function (d) { P(d, 'AI'); });
  K('cursor', 'AI');

  // Microsoft 走 Microsoft 分组
  ['microsoft.com', 'microsoftonline.com', 'office.com', 'office365.com', 'sharepoint.com',
    'outlook.com', 'live.com', 'msn.com', 'bing.com', 'azure.com', 'azure.net', 'xbox.com', 'windows.com', 'windows.net'].forEach(function (d) { P(d, 'Microsoft'); });
  K('microsoft', 'Microsoft');

  // 系统更新 / Apple 直连
  ['update.microsoft.com', 'windowsupdate.com', 'download.microsoft.com', 
   'herdr.dev', 'godotengine.org', 'your-objectstorage.com', 'workbuddy.ai'
  ].forEach(function (d) { P(d, 'DIRECT'); });
  ['apple.com', 'icloud.com', 'me.com', 'appsto.re', 'mzstatic.com', 'itunes.apple.com', 'push.apple.com'].forEach(function (d) { P(d, 'DIRECT'); });
  K('apple', 'DIRECT'); K('icloud', 'DIRECT');

  // 国内分流 -> DIRECT
  K('.cn', 'DIRECT');
  rules.push('GEOIP,CN,DIRECT');
  rules.push('GEOIP,PRIVATE,DIRECT');
  rules.push('MATCH,Default Proxy');

  // 用户自定义规则在前，GLaDOS 规则兜底在后
  const finalRules = mergedUserRules.concat(rules);

  // ---------- 6. 兜底清洗：确保分组自洽、无空组、无悬垂引用 ----------
  // 避免 mihomo 校验报错。核心防护：任何空引用的组，用 DIRECT 垫底，保证永不为空；
  // 再剔除引用不存在节点/分组的条目。
  const finalGroupNames = {};
  newGroups.forEach(function (g) { finalGroupNames[g.name] = true; });
  const leafNameSet = {};
  leaves.forEach(function (p) { leafNameSet[p.name] = true; });

  var finalSeen = {};
  newGroups.forEach(function (g) {
    // 重名：保留第一个，后续跳过
    if (finalSeen[g.name]) { return; }
    finalSeen[g.name] = true;

    if (Array.isArray(g.use) && g.use.length > 0) return; // provider 引用组，跳过(由内核校验)

    if (Array.isArray(g.proxies)) {
      // 过滤悬垂引用
      g.proxies = g.proxies.filter(function (p) {
        if (p === 'DIRECT' || p === 'REJECT' || p === 'REJECT-DROP' || p === 'PASS') return true;
        return leafNameSet[p] || (finalGroupNames[p] && p !== g.name);
      });
      // 空了就退化到全部节点；仍空(零节点)则用 DIRECT 保证合法
      if (g.proxies.length === 0) {
        if (allNames.length) g.proxies = allNames.slice();
        else g.proxies = ['DIRECT'];
      }
    }
  });
  // 按原名字去重（保留首个出现顺序），并去掉空组
  var ord = {}; var dedup = [];
  newGroups.forEach(function (g) { if (!ord[g.name]) { ord[g.name] = true; dedup.push(g); } });
  dedup = dedup.filter(function (g) {
    return !(Array.isArray(g.proxies) && g.proxies.length === 0) && !(Array.isArray(g.use) && g.use.length === 0);
  });

  config['proxy-groups'] = dedup;
  config.rules = finalRules;
  config.proxies = leaves;



  // opencode直接通过
  const openCodeRules = [
    'DOMAIN-SUFFIX,opencode.ai,DIRECT',
    'DOMAIN-KEYWORD,opencode,DIRECT',
    'DOMAIN-SUFFIX,zcode.ai,DIRECT',
    'DOMAIN-SUFFIX,zcode.z.ai,DIRECT',
    'DOMAIN-KEYWORD,zcode,DIRECT'
  ];

  // 3. 将直连规则插入到所有规则的最前面（保证最高优先级）
  config.rules = [...openCodeRules, ...config.rules];


  // 清理可能残留的旧规则引用导致报错的老字段
  delete config['rule-providers'];
  delete config['proxy-providers'];
  delete config['script'];

  return config;
}
