import { Alert, AlertDescription } from "@colosseumcoinckr/cds/components/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@colosseumcoinckr/cds/components/card";
import { Chip } from "@colosseumcoinckr/cds/components/chip";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@colosseumcoinckr/cds/components/empty";
import { Icon } from "@colosseumcoinckr/cds/components/icon";
import { features, screens } from "./screens";

/** Landing view: what exists, and where. Also the smoke test for CDS wiring. */
export function ScreenIndex({ missing }: { missing: string | null }) {
  return (
    <div className="bg-background-gray-bg min-h-full p-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <div>
          <h1 className="text-text-data text-xl font-semibold">화면 미리보기</h1>
          <p className="text-text-description mt-1">
            기획서에서 만들어진 화면 {screens.length}개
          </p>
        </div>

        {missing && (
          <Alert intent="warning">
            <AlertDescription>{missing} 화면을 찾을 수 없습니다.</AlertDescription>
          </Alert>
        )}

        {screens.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon name="drafts" size={24} />
              </EmptyMedia>
              <EmptyTitle>아직 화면이 없습니다</EmptyTitle>
              <EmptyDescription>
                채팅에 기획서를 첨부하고 만들고 싶은 화면을 말해 주세요.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          features.map((feature) => (
            <Card key={feature.name}>
              <CardHeader>
                <CardTitle>{feature.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2">
                  {feature.screens.map((screen) => (
                    <li key={screen.id}>
                      <a
                        className="hover:bg-background-opacity-bk4 flex items-center gap-3 rounded-md px-2 py-2"
                        href={`#/${screen.id}`}
                      >
                        <Icon name="web_asset" size={20} className="text-icon-natural" />
                        <span className="text-text-data font-medium">{screen.meta.title}</span>
                        <span className="text-text-description font-mono">{screen.id}</span>
                        {screen.meta.states?.map((state) => (
                          <Chip key={state} size="exSmall" variant="outline" intent="basic">
                            {state}
                          </Chip>
                        ))}
                      </a>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
