(() => {
  let mode = "system";
  try {
    const saved = localStorage.getItem("mkmn.appearance");
    if (saved === "light" || saved === "dark" || saved === "system") mode = saved;
  } catch { /* storage blocked: follow the system theme */ }
  const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();
