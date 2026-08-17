/*
 * Test helper for Combobox.vue: pick an option by value the way a user
 * would — open the popup with ArrowDown, then click the matching option.
 * The option elements carry data-value, so tests select by the underlying
 * value (string or number) rather than by visible label text.
 */
export async function chooseCombobox(w, id, value) {
  const input = w.find(`#${id}`);
  await input.trigger("keydown", { key: "ArrowDown" });
  const opt = w
    .findAll(`#${id} ~ ul [role="option"]`)
    .find((o) => o.attributes("data-value") === String(value));
  if (!opt) {
    throw new Error(`Combobox #${id} has no option with value ${value}`);
  }
  await opt.trigger("click");
}
