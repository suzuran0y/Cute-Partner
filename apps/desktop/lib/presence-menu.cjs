'use strict';
function presenceMenu({ alwaysOnTop, textMode, toggleCommunication, openInfo, openFood, openReader, setTopmost, quit }) {
  return [
    { id: 'open-info', label: '记小本本', click: openInfo },
    { id: 'typing-mode', label: textMode ? '能说话了' : '打字交流', click: toggleCommunication },
    { id: 'read-latest', label: '读读刚才', click: openReader },
    { id: 'remaining-rice', label: '伙食费', click: openFood },
    { id: 'stay-on-top', label: '过来待着', type: 'checkbox', checked: alwaysOnTop, click: item => setTopmost(item.checked) },
    { type: 'separator' },
    { id: 'sleep', label: '睡觉去吧', click: quit },
  ];
}
module.exports = { presenceMenu };
