import type { XiaoShuoDesktopApi } from "@xiaoshuo/shared";

declare global {
  interface Window {
    xiaoshuoDesktop: XiaoShuoDesktopApi;
  }
}
