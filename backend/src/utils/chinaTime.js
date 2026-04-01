/**
 * 中国时间工具函数 (CST, UTC+8)
 * 统一使用此文件处理时间，避免 toISOString() 返回 UTC 导致日期偏差
 */

/** 获取中国时间的当前 Date 对象（偏移后） */
function getChinaDate() {
  return new Date(Date.now() + 8 * 3600000);
}

/** 获取中国时间的日期字符串，格式 YYYY-MM-DD */
function getChinaDateString() {
  return getChinaDate().toISOString().slice(0, 10);
}

/** 获取中国时间的 ISO 字符串（带+08:00标识） */
function getChinaISOString() {
  const d = getChinaDate();
  return d.toISOString().slice(0, 19) + '+08:00';
}

module.exports = { getChinaDate, getChinaDateString, getChinaISOString };
