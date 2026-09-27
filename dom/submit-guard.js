// 主世界提交闸门：内容脚本跑在 isolated world，改 HTMLFormElement.prototype 对页面无效，
// 所以这段必须以 world:"MAIN" 注入到页面自己的世界。
// 边界要说清楚：只拦**程序化**提交（form.submit()/requestSubmit()/脚本派发的 submit 事件），
// 真人点击的提交（isTrusted=true）绝不拦 —— 用户自己按提交是需求，不是风险。

(() => {
  const win = window;
  if (win.__nwSubmitGuardInstalled) return;
  win.__nwSubmitGuardInstalled = true;
  win.__nwBlockedSubmits = 0;

  const notify = why => {
    win.__nwBlockedSubmits++;
    // 跨 world 传值只能靠 DOM：isolated world 里的内容脚本读不到主世界的 JS 变量，
    // 但能读这个纯计数器（只放数字，不放任何字段内容）
    try {
      const root = document.documentElement;
      root.dataset.nwBlockedSubmits = String(win.__nwBlockedSubmits);
      root.dispatchEvent(new CustomEvent('nw:submit-blocked', { bubbles: true, detail: { why } }));
      win.dispatchEvent(new CustomEvent('nw:submit-blocked', { detail: { why } }));
    } catch { /* 事件名冲突不影响拦截本身 */ }
  };

  const proto = win.HTMLFormElement && win.HTMLFormElement.prototype;
  if (!proto) return;
  const nativeSubmit = proto.submit;
  const nativeRequest = proto.requestSubmit;
  proto.submit = function blockedSubmit() {
    notify('form.submit()');
    return undefined;
  };
  if (nativeRequest) {
    proto.requestSubmit = function blockedRequestSubmit() {
      notify('form.requestSubmit()');
      return undefined;
    };
  }

  // 捕获阶段拦 untrusted 的 submit 事件；restore() 只用于扩展自检，不参与正常填写流程
  win.__nwSubmitGuardRestore = () => {
    proto.submit = nativeSubmit;
    if (nativeRequest) proto.requestSubmit = nativeRequest;
    win.removeEventListener('submit', handler, true);
    win.__nwSubmitGuardInstalled = false;
  };
  function handler(e) {
    if (e.isTrusted) return;   // 用户真实提交：放行
    e.preventDefault();
    e.stopImmediatePropagation();
    notify('synthetic submit event');
  }
  win.addEventListener('submit', handler, true);
})();
