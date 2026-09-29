NOTES V4 — PINK + AUTO SYNC

AVANT LA MISE À JOUR
1. Dans ta version actuelle de Notes, copie ton code de sauvegarde.
2. Garde-le temporairement.
3. Ne supprime aucun chat ChatGPT.

MISE À JOUR DU SITE PUBLIC
Dans le repo GitHub qui héberge déjà Notes, remplace :
- index.html
- app.js
- style.css
- manifest.webmanifest
- service-worker.js
- icon.svg
puis Commit changes.
Attends 1 à 2 minutes.

La V4 conserve le même nom de stockage local et le même format de chiffrement que la version précédente.
Sur ton appareil principal, ton PIN et tes chats existants devraient rester présents.

SYNCHRO AUTOMATIQUE
Crée un DEUXIÈME dépôt GitHub :
- nom conseillé : notes-vault-sync
- visibilité : PRIVATE
- PAS de GitHub Pages dessus.

Crée un fine-grained personal access token :
GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token.

Réglages :
- Repository access : Only select repositories
- sélectionne UNIQUEMENT notes-vault-sync
- Repository permissions > Contents : Read and write
- aucune autre permission n'est nécessaire pour Notes.

Dans Notes V4 :
Synchro automatique > Configurer
- ton pseudo GitHub
- notes-vault-sync
- ton token
- Activer la synchro

Notes crée vault.enc.json dans le dépôt privé.
Le fichier contient le coffre CHIFFRÉ.

IPHONE — UNE DERNIÈRE IMPORTATION
Après avoir activé la synchro sur le PC :
1. PC > Notes > Copier mon code de sauvegarde.
2. iPhone > Notes > Sauvegarde & nouvel appareil > Restaurer.
3. Colle ce NOUVEAU code.
4. Après ça, l'iPhone possède aussi la configuration GitHub chiffrée.
5. Dorénavant, à l'ouverture/retour dans Notes, l'app vérifie les changements automatiquement.

Quand tu ajoutes/renommes/catégorises/supprimes un raccourci sur le PC, Notes envoie la nouvelle version automatiquement après un court délai.
Quand tu ouvres Notes sur iPhone, il récupère la version plus récente. Même principe dans l'autre sens.

SÉCURITÉ
- Repo de l'app : peut rester public.
- Repo de synchro : PRIVATE.
- Ne mets JAMAIS le token dans le repo public.
- Utilise un fine-grained token limité au SEUL repo privé avec Contents read/write.
- Active 2FA/passkey sur GitHub.
- Le token est conservé à l'intérieur du coffre chiffré local et distant.

COÛT
Aucune API OpenAI.
Aucun crédit OpenAI.
La synchro utilise uniquement GitHub pour un petit fichier chiffré.
