import type { ReactNode } from "react";
import { Icon } from "@colosseumcoinckr/cds/components/icon";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@colosseumcoinckr/cds/components/sidebar";
import { TooltipProvider } from "@colosseumcoinckr/cds/components/tooltip";
import { features, type ScreenEntry } from "../screens";

/**
 * A stand-in admin shell so a screen is judged at the size and position it will
 * really occupy. It is deliberately not part of the handoff: the real app owns
 * its own navigation, and a screen that shipped its own would have to be
 * unwrapped again. Menu entries come from whatever screens exist.
 */
export function AdminFrame({ screen, children }: { screen: ScreenEntry; children: ReactNode }) {
  return (
    // The collapsed rail renders menu labels as tooltips, and Radix's tooltip
    // primitive throws without a provider. CDSProvider does not include one.
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Icon name="dashboard" size={20} className="text-icon-primary" />
              <span className="text-text-data text-sm font-semibold">관리자</span>
            </div>
          </SidebarHeader>
          <SidebarContent>
            {features.map((feature) => (
              <SidebarGroup key={feature.name}>
                <SidebarGroupLabel>{feature.name}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {feature.screens.map((entry) => (
                      <SidebarMenuItem key={entry.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={entry.id === screen.id}
                          tooltip={entry.meta.title}
                        >
                          <a href={`#/${entry.id}`}>
                            <Icon name="chevron_right" size={16} />
                            <span>{entry.meta.title}</span>
                          </a>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>
        </Sidebar>
        <SidebarInset>
          <header className="border-borders-outline flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger />
            <span className="text-text-data text-sm font-medium">{screen.meta.title}</span>
          </header>
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
