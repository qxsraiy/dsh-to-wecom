(() => {
  try {
    /* dsh-wecom-notify client half：会话级推送开关（输入区 dock 胶囊 + 面板） */
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

        var CHIP = {
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          padding: '3px 10px', borderRadius: '6px',
          border: '1px solid rgba(127,127,127,0.35)',
          background: 'rgba(127,127,127,0.10)',
          color: 'inherit', fontSize: '11px', lineHeight: '16px',
          fontFamily: 'inherit', cursor: 'pointer', userSelect: 'none',
          whiteSpace: 'nowrap', maxWidth: '100%'
        };
        var PANEL = {
          position: 'absolute', bottom: 'calc(100% + 6px)', left: '0',
          minWidth: '300px', maxHeight: '340px', overflowY: 'auto',
          padding: '8px', borderRadius: '8px', zIndex: 40,
          background: 'Canvas', color: 'CanvasText',
          border: '1px solid rgba(127,127,127,0.35)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          fontSize: '12px', lineHeight: '18px', textAlign: 'left'
        };
        var ROW = {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '10px', padding: '4px 6px', borderRadius: '5px', cursor: 'pointer'
        };
        var NAME = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' };
        var HINT = { opacity: 0.6, fontSize: '11px' };

        function Switch(props) {
          var on = props.on;
          return h('span', {
            style: {
              flex: 'none', width: '30px', height: '16px', borderRadius: '8px',
              background: on ? '#10b981' : 'rgba(127,127,127,0.45)',
              position: 'relative', transition: 'background 120ms ease'
            }
          }, h('span', {
            style: {
              position: 'absolute', top: '2px', left: on ? '16px' : '2px',
              width: '12px', height: '12px', borderRadius: '50%', background: '#fff',
              transition: 'left 120ms ease'
            }
          }));
        }

        function SessionChip(props) {
          var session = props.session || props.sessionSnapshot || null;
          var sessionId = (session && (session.id || session.sessionId)) || props.sessionId || '';

          var dataPair = react.useState(null);
          var data = dataPair[0];
          var setData = dataPair[1];
          var openPair = react.useState(false);
          var open = openPair[0];
          var setOpen = openPair[1];
          var errPair = react.useState('');
          var error = errPair[0];
          var setError = errPair[1];

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

          function commit(request, keepCurrent) {
            return request.then(function (payload) {
              setData(function (prev) {
                var next = {
                  defaultEnabled: payload.state.defaultEnabled,
                  sessions: payload.state.sessions
                };
                next.session = payload.session || (keepCurrent && prev ? prev.session : null);
                return next;
              });
              setError('');
            }).catch(function (err) {
              setError(String(err && err.message ? err.message : err));
            });
          }

          function toggleCurrent() {
            if (!sessionId) { setOpen(true); return; }
            void commit(post('/ctl/toggle', { sessionId: sessionId }), true);
          }
          function toggleRow(row) {
            void commit(post('/ctl/toggle', { sessionId: row.sessionId }), true);
          }
          function toggleDefault() {
            void commit(post('/ctl/default', { enabled: !(data && data.defaultEnabled) }), true);
          }

          var current = data && data.session ? data.session : null;
          var enabled = current ? current.enabled : (data ? data.defaultEnabled : true);
          var label = current ? (current.title || ('会话 ' + (current.shortId || ''))) : '通知';
          var text = error ? ('🔔 ' + label + ' · 离线') : ((enabled ? '🔔 ' : '🔕 ') + label + ' · ' + (enabled ? '开' : '关'));

          var chip = h('button', {
            type: 'button',
            title: current && current.sessionId
              ? ('会话：' + current.sessionId + (current.cwd ? ('\n目录：' + current.cwd) : '') + '\n点击切换本会话推送，▾ 打开全部会话')
              : '本会话推送开关',
            style: CHIP,
            onClick: toggleCurrent,
            onContextMenu: function (event) { event.preventDefault(); setOpen(!open); }
          }, text, h('span', {
            style: { opacity: 0.65, cursor: 'pointer', paddingLeft: '2px' },
            onClick: function (event) { event.stopPropagation(); setOpen(!open); }
          }, '▾'));

          var panel = null;
          if (open) {
            var rows = ((data && Array.isArray(data.sessions)) ? data.sessions : []).map(function (row) {
              return h('div', {
                key: row.sessionId,
                style: Object.assign({}, ROW, row.sessionId === sessionId ? { background: 'rgba(127,127,127,0.14)' } : null),
                onClick: function () { toggleRow(row); },
                title: row.sessionId + (row.cwd ? ('\n' + row.cwd) : '')
              }, h('span', { style: NAME }, row.title + ' · ' + (row.shortId || '')), h(Switch, { on: row.enabled !== false }));
            });
            if (rows.length === 0) rows = [h('div', { key: 'empty', style: HINT }, '还没有会话记录')];
            panel = h('div', { style: PANEL },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 6px 6px' } },
                h('span', { style: { fontWeight: 600 } }, '会话推送开关'),
                h('span', { style: HINT }, '按会话区分，点一行切换')),
              h('div', { style: ROW, onClick: toggleDefault, key: 'default' },
                h('span', { style: NAME }, '默认（未单独设置的会话）'),
                h(Switch, { on: !!(data && data.defaultEnabled) })),
              h('div', { style: { height: '1px', background: 'rgba(127,127,127,0.25)', margin: '6px 4px' } }),
              rows,
              error ? h('div', { style: { color: '#ef4444', padding: '4px 6px' } }, '接口错误：' + error) : null,
              h('div', { style: Object.assign({}, HINT, { padding: '6px 6px 0' }) }, '数据来自 127.0.0.1:8791 · 每 15 秒刷新')
            );
          }

          return h('div', {
            style: { position: 'relative', display: 'flex', justifyContent: 'center', width: '100%' },
            'data-plugin': 'dsh-wecom-notify'
          }, chip, panel);
        }

        function apply(ctx) {
          ctx.slots.inject('conversation.input.dock', function () {
            return ctx.slots.register({
              name: 'conversation.input.dock',
              id: 'dsh-wecom-notify:toggle',
              order: 40
            }, SessionChip);
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
