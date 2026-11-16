# Hermes Bots

Client téléphone du Bot Mode de Hermes : Yoan y parle à ses bots, seul ou en groupe.

## Langage

**Bot** :
Un profil Hermes, vu comme un interlocuteur avec un nom et une seule conversation.
_Éviter_ : profil (sauf pour parler de Hermes lui-même), agent

**Conversation du bot** :
L'unique fil d'échange entre Yoan et un bot, où arrivent aussi ses tâches automatiques.
_Éviter_ : session, chat, Bot Chat

**Tâche automatique** :
Une exécution programmée qu'un bot réalise seul, dont le résultat se pose dans la conversation du bot pour en discuter ensuite.
_Éviter_ : cron, cronjob, notif de cron

**Résultat silencieux** :
Une tâche automatique qui n'a rien à signaler ; elle ne laisse aucune trace dans la conversation.
_Éviter_ : [SILENT], sortie vide

**Groupe** :
Une conversation à plusieurs bots, toujours conduite par un meneur.
_Éviter_ : salle, room, équipe

**Meneur** :
Le bot d'un groupe qui reçoit les messages de Yoan et distribue le travail aux autres membres.
_Éviter_ : lead, chef

**Table ronde** :
Le travail que le meneur confie à plusieurs bots du groupe en même temps ; chacun travaille en coulisse puis poste son résultat dans le groupe.
_Éviter_ : dispatch, fan-out, file d'attente

**Fil de travail** :
Ce qu'un bot fait pendant un travail de groupe, de bout en bout : ses messages intermédiaires et ses actions (outils), jusqu'au résultat posté dans le groupe. Un travail, un fil.
_Éviter_ : coulisses, journal, log, trace

**Horloge** :
Ce que chaque bot sait du temps à chaque tour : la date et l'heure de Paris, et le temps écoulé depuis le message précédent de sa conversation.
_Éviter_ : horodatage, timestamp, date du message

**Discussion** :
Ce que le groupe fait à partir d'un message de Yoan : le meneur répond, puis les bots qu'il cite, jusqu'à ce que plus personne ne soit cité, ou jusqu'à ce que Yoan l'arrête. Un groupe ne mène qu'une discussion à la fois ; après un arrêt, le message suivant de Yoan ouvre une nouvelle discussion.
_Éviter_ : conversation (réservé au bot seul), thread, fil

**Tâche de groupe** :
Une demande de travail de Yoan que le meneur inscrit au tableau du groupe, avec un titre court. Une réponse, une relance ou une information (« go », « voilà ») n'en crée pas : elle se rattache à la tâche en cours. Une tâche se ferme d'elle-même quand sa discussion et ses tables rondes sont terminées, sauf si un bot la garde en cours ou la déclare bloquée.
_Éviter_ : tâche (seul, ambigu avec tâche automatique), ticket, todo

**Tableau du groupe** :
L'ensemble des tâches de groupe, rangées par état (à faire, en cours, bloquée, faite).
_Éviter_ : task manager, liste de tâches

**Message en attente** :
Un message de Yoan envoyé pendant une discussion. Il passe avant les résultats de table ronde et les tâches automatiques : le bot qui écrit finit son tour, la discussion s'arrête là sans reprendre, et le meneur lit d'un coup tous les messages en attente, suivis des résultats arrivés entre-temps. La bulle dit qui elle attend.
_Éviter_ : file, queue, en file

**Carte** :
Un élément visuel qu'un bot met dans sa réponse et que l'app dessine (récap, tableau, liste cochée, boutons...), à la place d'un long texte.
_Éviter_ : bloc, widget, bots-ui (sauf pour parler du format)

**Carte illisible** :
Une carte que le bot a mal écrite et que l'app ne peut pas dessiner. Son contenu est remis en texte, et l'original reste consultable sous « voir le brut » : rien n'est perdu.
_Éviter_ : bloc illisible, bloc invalide
