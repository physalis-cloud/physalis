import {
  RiGithubFill,
  RiGitlabFill,
  RiLinkUnlink,
  RiVercelLine,
  RiChinaRailwayLine,
  RiMailCheckLine,
  RiMailLine,
  RiSafe2Line,
  RiRouteLine,
  type RemixiconComponentType,
} from "@remixicon/react";

// Données normalisées affichées sous le label d'une card projet.
// Première zone = connexion externe : plateforme(s) de sync sortante si
// configurée(s) (prioritaire), sinon provider CI/CD, sinon connecteur barré.
// email/backup/api ne s'affichent que s'ils sont configurés.
export type ProjectStatusData = {
  ciProvider: string | null; // "github" | "gitlab" | "bitbucket" | null
  syncProviders: string[]; // sous-ensemble de "vercel" | "render" | "railway"
  emailConfigured: boolean;
  emailVerified: boolean;
  backupEnabled: boolean;
  apiCount: number;
};

const ACTIVE = "var(--muted)"; // monochrome discret, lisible
const GREYED = "#c4bdb0"; // état « présent mais inactif » (CI absent, email non vérifié)
const SIZE = 15;

// Un glyphe = soit une icône Remix (`Icon`), soit un logo PNG teinté (`mask`,
// masque alpha monochrome dans /public → s'adapte au thème via currentColor).
type Glyph = {
  title: string;
  color: string;
  Icon?: RemixiconComponentType;
  mask?: string;
};

function ci(provider: string | null): Glyph {
  switch (provider) {
    case "github":
      return { Icon: RiGithubFill, title: "CI/CD : GitHub", color: ACTIVE };
    case "gitlab":
      return { Icon: RiGitlabFill, title: "CI/CD : GitLab", color: ACTIVE };
    case "bitbucket":
      // Pas d'icône Bitbucket dans Remix → logo de marque teinté (mask).
      return { mask: "/bitbucket.png", title: "CI/CD : Bitbucket", color: ACTIVE };
    default:
      return { Icon: RiLinkUnlink, title: "Aucun connecteur CI/CD", color: GREYED };
  }
}

function syncMeta(provider: string): Glyph {
  switch (provider) {
    case "vercel":
      return { Icon: RiVercelLine, title: "Sync sortante : Vercel", color: ACTIVE };
    case "railway":
      return { Icon: RiChinaRailwayLine, title: "Sync sortante : Railway", color: ACTIVE };
    case "render":
      // Pas d'icône Render dans Remix → logo de marque teinté (mask).
      return { mask: "/render.png", title: "Sync sortante : Render", color: ACTIVE };
    default:
      return { Icon: RiLinkUnlink, title: `Sync sortante : ${provider}`, color: ACTIVE };
  }
}

// Logo PNG affiché comme masque alpha teinté par `currentColor` : monochrome,
// fond transparent, s'adapte au thème comme les icônes Remix voisines.
function MaskIcon({ src }: { src: string }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: SIZE,
        height: SIZE,
        backgroundColor: "currentColor",
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}

function GlyphBadge({ glyph, name }: { glyph: Glyph; name?: string }) {
  const { Icon } = glyph;
  return (
    <span
      key={name}
      title={glyph.title}
      style={{ display: "inline-flex", color: glyph.color }}
    >
      {glyph.mask ? <MaskIcon src={glyph.mask} /> : Icon ? <Icon size={SIZE} /> : null}
    </span>
  );
}

export default function ProjectStatusIcons({ data }: { data: ProjectStatusData }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {data.syncProviders.length > 0 ? (
        // Sync sortante prioritaire : une icône par plateforme (souvent une seule).
        data.syncProviders.map((p) => (
          <GlyphBadge key={p} name={p} glyph={syncMeta(p)} />
        ))
      ) : (
        <GlyphBadge glyph={ci(data.ciProvider)} />
      )}

      {data.emailConfigured &&
        (data.emailVerified ? (
          <span title="Email : domaine vérifié" style={{ display: "inline-flex", color: ACTIVE }}>
            <RiMailCheckLine size={SIZE} />
          </span>
        ) : (
          <span title="Email : domaine non vérifié" style={{ display: "inline-flex", color: GREYED }}>
            <RiMailLine size={SIZE} />
          </span>
        ))}

      {data.backupEnabled && (
        <span title="Sauvegarde configurée" style={{ display: "inline-flex", color: ACTIVE }}>
          <RiSafe2Line size={SIZE} />
        </span>
      )}

      {data.apiCount > 0 && (
        <span
          title={`API créée${data.apiCount > 1 ? "s" : ""} : ${data.apiCount}`}
          style={{ display: "inline-flex", color: ACTIVE }}
        >
          <RiRouteLine size={SIZE} />
        </span>
      )}
    </div>
  );
}
