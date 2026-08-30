/*
 * ZCode 3.9.2 CDP 外置补丁 - ESM 注册入口
 * NODE_OPTIONS --import 指向本文件；注册 loader.mjs 到模块定制管线。
 */
import { register } from 'node:module';

register(new URL('./loader.mjs', import.meta.url));
