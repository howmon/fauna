function _decisionPromptModel(action) {
  action = action || {};
  var options = Array.isArray(action.options) && action.options.length
    ? action.options.slice()
    : [
        {
          id: 'completed',
          label: 'I completed sign-in',
          description: 'Verify authentication once, then continue the current task.',
          recommended: true,
          response: 'I completed the Cowork browser sign-in. Verify authentication once and continue the task.',
        },
        {
          id: 'retry',
          label: 'Retry browser sign-in',
          description: 'Start one new browser login without using device-code authentication.',
          response: 'Retry Cowork authentication once using cowork auth login without the device-code option, then wait for me.',
        },
      ];
  options.sort(function(a, b) { return Number(!!b.recommended) - Number(!!a.recommended); });
  return {
    id: action.id || ('decision-' + Date.now()),
    title: action.title || 'Your input is required',
    prompt: action.prompt || 'Fauna is waiting for you before it can continue.',
    options: options,
    allowCustom: action.allowCustom !== false,
    customLabel: action.customLabel || 'Something else',
    customPlaceholder: action.customPlaceholder || 'Tell Fauna what to do instead…',
  };
}

function _decisionPromptEl(tag, className, text) {
  var element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function hideDecisionPrompt(opts) {
  opts = opts || {};
  var host = document.getElementById('decision-prompt-host');
  var inputWrap = document.getElementById('input-wrap');
  if (host) {
    host.hidden = true;
    host.replaceChildren();
  }
  if (inputWrap) inputWrap.hidden = false;
  if (opts.focus) {
    var input = document.getElementById('msg-input');
    if (input) input.focus();
  }
}

function renderDecisionPrompt(action, conv) {
  var host = document.getElementById('decision-prompt-host');
  var inputWrap = document.getElementById('input-wrap');
  if (!host || !inputWrap || !conv) return;

  var decision = _decisionPromptModel(action);
  var titleId = 'decision-prompt-title-' + String(decision.id).replace(/[^a-z0-9_-]/gi, '');
  var form = _decisionPromptEl('form', 'decision-prompt');
  form.setAttribute('aria-labelledby', titleId);

  var header = _decisionPromptEl('div', 'decision-prompt-header');
  var heading = _decisionPromptEl('div', 'decision-prompt-title', decision.title);
  heading.id = titleId;
  header.appendChild(heading);
  var dismiss = _decisionPromptEl('button', 'decision-prompt-dismiss');
  dismiss.type = 'button';
  dismiss.title = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss decision prompt');
  dismiss.innerHTML = '<i class="ti ti-x" aria-hidden="true"></i>';
  header.appendChild(dismiss);
  form.appendChild(header);
  form.appendChild(_decisionPromptEl('p', 'decision-prompt-copy', decision.prompt));

  var options = _decisionPromptEl('fieldset', 'decision-prompt-options');
  options.setAttribute('aria-label', decision.prompt || decision.title);
  var recommended = decision.options.find(function(option) { return option && option.recommended; });
  var selectedId = recommended ? recommended.id : (decision.options[0] && decision.options[0].id);

  decision.options.forEach(function(option) {
    if (!option || !option.id || !option.label) return;
    var label = _decisionPromptEl('label', 'decision-prompt-option' + (option.recommended ? ' is-recommended' : ''));
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'decision-option';
    radio.value = option.id;
    radio.checked = option.id === selectedId;
    var content = _decisionPromptEl('span', 'decision-prompt-option-content');
    var labelRow = _decisionPromptEl('span', 'decision-prompt-option-label');
    labelRow.appendChild(document.createTextNode(option.label));
    if (option.recommended) labelRow.appendChild(_decisionPromptEl('span', 'decision-prompt-recommended', 'Recommended'));
    content.appendChild(labelRow);
    if (option.description) content.appendChild(_decisionPromptEl('span', 'decision-prompt-option-description', option.description));
    if (option.impact && (option.impact.risk || option.impact.detail || option.impact.consequence)) {
      var impactText = [option.impact.risk ? String(option.impact.risk).toUpperCase() + ' risk' : '', option.impact.detail || option.impact.consequence || ''].filter(Boolean).join(' · ');
      content.appendChild(_decisionPromptEl('span', 'decision-prompt-impact risk-' + (option.impact.risk || 'low'), impactText));
    }
    label.appendChild(radio);
    label.appendChild(content);
    options.appendChild(label);
  });

  var customInput = null;
  if (decision.allowCustom) {
    var customLabel = _decisionPromptEl('label', 'decision-prompt-option decision-prompt-custom-option');
    var customRadio = document.createElement('input');
    customRadio.type = 'radio';
    customRadio.name = 'decision-option';
    customRadio.value = '__custom__';
    customLabel.appendChild(customRadio);
    customLabel.appendChild(_decisionPromptEl('span', 'decision-prompt-option-label', decision.customLabel));
    options.appendChild(customLabel);
    customInput = document.createElement('textarea');
    customInput.className = 'decision-prompt-custom-input';
    customInput.rows = 2;
    customInput.placeholder = decision.customPlaceholder;
    customInput.setAttribute('aria-label', decision.customPlaceholder);
    customInput.hidden = true;
    options.appendChild(customInput);
    customRadio.addEventListener('change', function() {
      customInput.hidden = false;
      customInput.focus();
      requestAnimationFrame(function() {
        customInput.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        var stickyFooter = form.querySelector('.decision-prompt-footer');
        if (!stickyFooter) return;
        var inputBox = customInput.getBoundingClientRect();
        var footerBox = stickyFooter.getBoundingClientRect();
        var overlap = inputBox.bottom - footerBox.top;
        if (overlap >= 0) form.scrollTop += overlap + 8;
      });
    });
    customInput.addEventListener('focus', function() { customRadio.checked = true; });
  }
  form.appendChild(options);

  var footer = _decisionPromptEl('div', 'decision-prompt-footer');
  footer.appendChild(_decisionPromptEl('span', 'decision-prompt-hint', 'Paused for your response'));
  var actions = _decisionPromptEl('div', 'decision-prompt-actions');
  var cancel = _decisionPromptEl('button', 'decision-prompt-button secondary', 'Cancel');
  cancel.type = 'button';
  var submit = _decisionPromptEl('button', 'decision-prompt-button primary', 'Submit');
  submit.type = 'submit';
  submit.disabled = !!conv._streaming;
  if (conv._streaming) submit.title = 'Available when Fauna finishes its response';
  actions.appendChild(cancel);
  actions.appendChild(submit);
  footer.appendChild(actions);
  form.appendChild(footer);

  function dismissPrompt() {
    conv._decisionPromptDismissed = true;
    hideDecisionPrompt({ focus: true });
    if (typeof saveConversations === 'function') saveConversations();
  }
  dismiss.addEventListener('click', dismissPrompt);
  cancel.addEventListener('click', dismissPrompt);
  form.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismissPrompt();
    }
  });
  form.addEventListener('change', function(event) {
    if (event.target && event.target.name === 'decision-option' && event.target.value !== '__custom__' && customInput) customInput.hidden = true;
  });
  form.addEventListener('submit', function(event) {
    event.preventDefault();
    var selected = form.querySelector('input[name="decision-option"]:checked');
    if (!selected) return;
    var response = '';
    if (selected.value === '__custom__') {
      response = customInput ? customInput.value.trim() : '';
      if (!response) {
        if (customInput) customInput.focus();
        return;
      }
    } else {
      var option = decision.options.find(function(item) { return item.id === selected.value; });
      response = option && (option.response || option.label);
    }
    if (!response) return;
    delete conv._decisionPromptDismissed;
    hideDecisionPrompt();
    var input = document.getElementById('msg-input');
    if (!input) return;
    input.value = response;
    if (typeof resizeTextarea === 'function') resizeTextarea(input);
    if (typeof sendMessage === 'function') sendMessage();
  });

  host.replaceChildren(form);
  host.hidden = false;
  inputWrap.hidden = true;
  var checked = form.querySelector('input[name="decision-option"]:checked');
  if (checked) checked.focus();
}

function syncDecisionPromptForCurrentConversation() {
  var conv = typeof getConv === 'function' ? getConv(state.currentId) : null;
  if (conv && conv._waitingForUserAction && !conv._decisionPromptDismissed) renderDecisionPrompt(conv._waitingForUserAction, conv);
  else hideDecisionPrompt();
}