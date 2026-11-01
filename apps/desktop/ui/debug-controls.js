(() => {
  const host = window.desktop, button = document.getElementById('speech-prepare'), label = document.getElementById('speech-resource-state');
  button.onclick = async () => { button.disabled = true; label.textContent = '正在准备并核验本地组件…'; try { const result = await host.settingsCommand({ action: 'prepare-speech' }); if (!result.ok) throw Error(result.error); label.textContent = '本地识别组件已就绪。'; } catch (error) { label.textContent = error.message; } finally { button.disabled = false; } };
})();
