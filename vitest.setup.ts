/**
 * 全局测试前置。
 *
 * 只做一件事：把 core 层的翻译器指向真实的中文 bundle。
 * 这样源码里的英文 message 在测试中仍产出中文，既有的中文断言继续有效，
 * 同时顺带校验 bundle 的 key 与源码英文原文是否对得上。
 */

import { installChineseTranslator } from './src/test/i18nStub';

installChineseTranslator();
