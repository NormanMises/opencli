/**
 * BOSS直聘 job search — browser cookie API.
 * Supports city names (中文), experience, degree, salary range, and industry filters.
 */
import { cli, Strategy } from '../../registry.js';

/** City name → BOSS Zhipin city code mapping (most popular cities) */
const CITY_CODES: Record<string, string> = {
  '全国': '100010000', '北京': '101010100', '上海': '101020100',
  '广州': '101280100', '深圳': '101280600', '杭州': '101210100',
  '成都': '101270100', '南京': '101190100', '武汉': '101200100',
  '西安': '101110100', '苏州': '101190400', '长沙': '101250100',
  '天津': '101030100', '重庆': '101040100', '郑州': '101180100',
  '东莞': '101281600', '青岛': '101120200', '合肥': '101220100',
  '佛山': '101280800', '宁波': '101210400', '厦门': '101230200',
  '大连': '101070200', '珠海': '101280700', '无锡': '101190200',
  '济南': '101120100', '福州': '101230100', '昆明': '101290100',
  '哈尔滨': '101050100', '沈阳': '101070100', '石家庄': '101090100',
  '贵阳': '101260100', '南宁': '101300100', '太原': '101100100',
  '海口': '101310100', '兰州': '101160100', '乌鲁木齐': '101130100',
};

/** Experience filter values */
const EXP_MAP: Record<string, string> = {
  '不限': '', '应届': '108', '1年以内': '101', '1-3年': '102',
  '3-5年': '103', '5-10年': '104', '10年以上': '105',
};

/** Degree filter values */
const DEGREE_MAP: Record<string, string> = {
  '不限': '', '初中及以下': '209', '中专/中技': '208', '高中': '206',
  '大专': '202', '本科': '203', '硕士': '204', '博士': '205',
};

/** Salary filter values */
const SALARY_MAP: Record<string, string> = {
  '不限': '', '3K以下': '402', '3-5K': '403', '5-10K': '404',
  '10-20K': '405', '20-50K': '406', '50K以上': '407',
};

function resolveCity(input: string): string {
  if (!input) return '101010100';
  // If it's already a numeric code, use directly
  if (/^\d+$/.test(input)) return input;
  // Try exact match first
  if (CITY_CODES[input]) return CITY_CODES[input];
  // Fuzzy match: find first city that starts with or contains the input
  for (const [name, code] of Object.entries(CITY_CODES)) {
    if (name.includes(input)) return code;
  }
  return '101010100'; // default to Beijing
}

function resolveMap(input: string | undefined, map: Record<string, string>): string {
  if (!input) return '';
  if (map[input]) return map[input];
  // Try partial match
  for (const [key, val] of Object.entries(map)) {
    if (key.includes(input)) return val;
  }
  return input; // pass through raw value
}

cli({
  site: 'boss',
  name: 'search',
  description: 'BOSS直聘搜索职位',
  domain: 'www.zhipin.com',
  strategy: Strategy.COOKIE,
  forceExtension: true,  // BOSS Zhipin detects CDP mode — must use extension bridge
  args: [
    { name: 'query', required: true, help: 'Search keyword (e.g. AI agent, 前端)' },
    { name: 'city', default: '北京', help: 'City name or code (e.g. 杭州, 上海, 101010100)' },
    { name: 'experience', default: '', help: 'Experience: 应届/1年以内/1-3年/3-5年/5-10年/10年以上' },
    { name: 'degree', default: '', help: 'Degree: 大专/本科/硕士/博士' },
    { name: 'salary', default: '', help: 'Salary: 3K以下/3-5K/5-10K/10-20K/20-50K/50K以上' },
    { name: 'industry', default: '', help: 'Industry code (e.g. 100020)' },
    { name: 'page', type: 'int', default: 1, help: 'Page number' },
    { name: 'limit', type: 'int', default: 15, help: 'Number of results' },
  ],
  columns: ['name', 'salary', 'company', 'area', 'experience', 'degree', 'skills', 'boss', 'url'],
  func: async (page, kwargs) => {
    await page.goto('https://www.zhipin.com');
    await page.wait(2);

    const cityCode = resolveCity(kwargs.city);
    const expVal = resolveMap(kwargs.experience, EXP_MAP);
    const degreeVal = resolveMap(kwargs.degree, DEGREE_MAP);
    const salaryVal = resolveMap(kwargs.salary, SALARY_MAP);
    const query = (kwargs.query || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const data = await page.evaluate(`
      (async () => {
        const params = new URLSearchParams({
          scene: '1', query: '${query}',
          city: '${cityCode}', page: '${kwargs.page || 1}', pageSize: '15',
          experience: '${expVal}', degree: '${degreeVal}',
          salary: '${salaryVal}', industry: '${kwargs.industry || ''}',
          payType: '', partTime: '', scale: '', stage: '',
          position: '', jobType: '',
          multiBusinessDistrict: '', multiSubway: ''
        });
        const resp = await fetch('/wapi/zpgeek/search/joblist.json?' + params.toString(), {credentials: 'include'});
        if (!resp.ok) return {error: 'HTTP ' + resp.status};
        const d = await resp.json();
        if (d.code !== 0) return {error: d.message || 'API error'};
        const zpData = d.zpData || {};
        return (zpData.jobList || []).map(j => ({
          name: j.jobName,
          salary: j.salaryDesc,
          company: j.brandName,
          area: [j.cityName, j.areaDistrict, j.businessDistrict].filter(Boolean).join('·'),
          experience: j.jobExperience,
          degree: j.jobDegree,
          skills: (j.skills || []).join(','),
          boss: j.bossName + ' · ' + j.bossTitle,
          url: j.encryptJobId ? 'https://www.zhipin.com/job_detail/' + j.encryptJobId + '.html' : ''
        }));
      })()
    `);
    if (!Array.isArray(data)) return [];
    return data.slice(0, kwargs.limit || 15);
  },
});

