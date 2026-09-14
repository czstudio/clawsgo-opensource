// 统一错误：抛出 ApiError 会被分发器转成 {error:{code,message}} + HTTP 状态。
// code 取值对齐前端 ApiError.code 的判断分支（UNAUTHORIZED / NOT_FOUND / CONFLICT / ...）。

export class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export const fail = (code, message, status = 400) => {
  throw new ApiError(code, message, status);
};

export const notFound = (what = '资源') => fail('NOT_FOUND', `${what}不存在`, 404);
export const unauthorized = (msg = '未登录') => fail('UNAUTHORIZED', msg, 401);
export const badRequest = (msg, code = 'BAD_REQUEST') => fail(code, msg, 400);
export const conflict = (msg) => fail('CONFLICT', msg, 409);
export const forbidden = (msg = '没有权限') => fail('FORBIDDEN', msg, 403);

/** 断言工具：条件为假即抛 */
export function need(cond, code, message, status = 400) {
  if (!cond) throw new ApiError(code, message, status);
  return cond;
}

/** 取必填字段 */
export function req(obj, key, code = 'BAD_REQUEST') {
  const v = obj?.[key];
  if (v === undefined || v === null || v === '') throw new ApiError(code, `缺少参数 ${key}`, 400);
  return v;
}
