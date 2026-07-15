import type { ReactNode } from "react";

export default function TutosLayout({ children }: { children: ReactNode }) {
  return (
    <div className="page">
      <div className="page-content">{children}</div>
    </div>
  );
}
