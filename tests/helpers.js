/*
 * 测试辅助：把扩展脚本按需加载进 node。
 * 项目本身无构建步骤、无第三方依赖，测试只用 node 内置能力。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * 加载 shared/ 下的脚本（它们都是 (function(g){...})(globalThis)，会把符号挂到 globalThis）。
 * @param {string} rel 相对仓库根目录的路径
 */
function loadShared(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  (0, eval)(code); // 间接 eval → 全局作用域执行
}

/**
 * 从某个脚本里截取一段源码并求值，返回其中声明的符号。
 * 用于测试内嵌在大文件里的纯函数，避免为测试而改动运行时结构。
 * @param {string} rel 脚本路径
 * @param {string} from 起始标记（含）
 * @param {string} to 结束标记（不含）
 * @param {string[]} names 需要取出的顶层函数名
 * @returns {Object<string, Function>}
 */
function loadSlice(rel, from, to, names) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error('源码切片失败：' + rel + ' [' + from + ' → ' + to + ']');
  }
  // 用 new Function 而不是 eval：切片里的函数声明不会污染本模块作用域
  const factory = new Function(src.slice(a, b) + '\nreturn {' + names.join(',') + '};');
  return factory();
}

module.exports = { ROOT, loadShared, loadSlice };
