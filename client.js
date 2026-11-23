(() => {
  try {
    /* dsh-wecom-notify client half：只播当前会话的推送开关，右下角一枚小按钮 */
    window.__ModuleLoader__.load({
      id: 'dsh-wecom-notify',
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        var react = require('react');
        var h = react.createElement;
        var BASE = 'http://127.0.0.1:8791';

        function post(path, payload) {
          return fetch(BASE + path, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload || {})
          }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          });
        }
        function get(path) {
          return fetch(BASE + path, { cache: 'no-store' }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          });
        }

        var DOCK = {
          display: 'flex', width: '100%',
          justifyContent: 'flex-end', alignItems: 'center',
          padding: '0 8px 2px 0', pointerEvents: 'none'
        };
        var BUTTON = {
          pointerEvents: 'auto',
          display: 'inline-flex', alignItems: 'center', gap: '5px',
          padding: '2px 8px', borderRadius: '999px',
          border: '1px solid rgba(127,127,127,0.35)',
          background: 'rgba(127,127,127,0.10)',
          color: 'inherit', fontSize: '11px', lineHeight: '16px',
          fontFamily: 'inherit', cursor: 'pointer', userSelect: 'none',
          whiteSpace: 'nowrap', maxWidth: '220px'
        };
        var DOT = { width: '6px', height: '6px', borderRadius: '50%', flex: 'none' };

        function SessionNotifyButton(props) {
          var session = props.session || props.sessionSnapshot || null;
          var sessionId = (session && (session.id || session.sessionId)) || props.sessionId || '';

          var dataPair = react.useState(null);
          var data = dataPair[0];
          var setData = dataPair[1];
          var errPair = react.useState('');
          var error = errPair[0];
          var setError = errPair[1];
          var busyPair = react.useState(false);
          var busy = busyPair[0];
          var setBusy = busyPair[1];

          var load = react.useCallback(function () {
            var query = sessionId ? ('?session=' + encodeURIComponent(sessionId)) : '';
            return get('/ctl/state' + query).then(function (payload) {
              setData(payload);
              setError('');
            }).catch(function (err) {
              setError(String(err && err.message ? err.message : err));
            });
          }, [sessionId]);

          react.useEffect(function () {
            var alive = true;
            void load();
            var timer = setInterval(function () { if (alive) void load(); }, 15000);
            return function () { alive = false; clearInterval(timer); };
          }, [load]);

          function toggle() {
            if (!sessionId || busy) return;
            setBusy(true);
            post('/ctl/toggle', { sessionId: sessionId }).then(function (payload) {
              setData(function (prev) {
                return {
                  defaultEnabled: payload.state ? payload.state.defaultEnabled : (prev ? prev.defaultEnabled : true),
                  session: payload.session || null
                };
              });
              setError('');
            }).catch(function (err) {
              setError(String(err && err.message ? err.message : err));
            }).then(function () { setBusy(false); });
          }

          var current = data && data.session ? data.session : null;
          var enabled = current ? current.enabled !== false : !!(data && data.defaultEnabled !== false);
          var title = current && current.title ? current.title : '';
          var label = error ? '通知离线' : (enabled ? '推送开' : '推送关');
          var tooltip = error
            ? ('控制接口不可达：' + error)
            : (sessionId
                ? ((enabled ? '关闭' : '开启') + '本会话的企业微信推送\n' + (title ? ('会话：' + title + '\n') : '') + 'ID：' + sessionId)
                : '取不到当前会话 ID，无法切换');

          var buttonStyle = {
            opacity: error || !sessionId ? 0.55 : 1,
            cursor: error || !sessionId ? 'default' : 'pointer'
          };
          var dotStyle = {
            background: error ? '#ef4444' : (enabled ? '#10b981' : 'rgba(127,127,127,0.6)')
          };

          return h('div', { style: DOCK, 'data-plugin': 'dsh-wecom-notify' },
            h('button', {
              type: 'button',
              title: tooltip,
              disabled: !sessionId || !!error,
              onClick: toggle,
              style: Object.assign({}, BUTTON, buttonStyle)
            },
              h('span', { style: Object.assign({}, DOT, dotStyle) }),
              h('span', null, '🔔 ' + label)
            )
          );
        }

        function apply(ctx) {
          ctx.slots.inject('conversation.input.dock', function () {
            return ctx.slots.register({
              name: 'conversation.input.dock',
              id: 'dsh-wecom-notify:toggle',
              order: 40
            }, SessionNotifyButton);
          });
        }

        exports.name = 'dsh-wecom-notify';
        exports.inject = ['slots'];
        exports.apply = apply;
        return module.exports;
      }
    });
  } catch (err) {
    console.warn('[dsh-wecom-notify] client runtime error:', err);
  }
})();
