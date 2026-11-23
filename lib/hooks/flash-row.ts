/** 표의 한 줄로 화면을 옮기고, 어느 줄인지 알 수 있게 몇 초 동안 파란 테두리를 깜빡인다 */
export function flashRow(el: Element | null | undefined): boolean {
  if (!el) return false;
  el.scrollIntoView({ block: "center", inline: "start", behavior: "smooth" });
  el.animate(
    [
      { outline: "3px solid #2563eb", outlineOffset: "-3px", backgroundColor: "rgba(37, 99, 235, 0.14)" },
      { outline: "3px solid #2563eb", outlineOffset: "-3px", backgroundColor: "rgba(37, 99, 235, 0.14)", offset: 0.7 },
      { outline: "3px solid transparent", outlineOffset: "-3px", backgroundColor: "transparent" },
    ],
    { duration: 5000 },
  );
  return true;
}
