import { Button } from "@colosseumcoinckr/cds/components/button";
import { rows } from "./Demo.mock";

export const meta = {
  title: "데모",
  states: ["default", "empty"],
};

export default function DemoScreen({ state = "default" }: { state?: string }) {
  const visible = state === "empty" ? [] : rows;
  return (
    <div className="bg-background-white text-text-data p-4">
      {visible.map((row) => (
        <p key={row.id}>{row.name}</p>
      ))}
      <Button>확인</Button>
    </div>
  );
}
