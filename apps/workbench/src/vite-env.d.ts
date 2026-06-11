/// <reference types="vite/client" />

import type { XiaoShuoDesktopApi } from "@xiaoshuo/shared";

declare global {
  interface Window {
    xiaoshuoDesktop?: XiaoShuoDesktopApi;
  }
}

export {};
