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
Le bot d'un groupe qui reçoit les messages de Yoan, distribue le travail aux autres membres et conclut auprès de lui. Il coordonne et ne fait jamais le travail lui-même : il peut lire, répondre, résumer et trancher, mais toute action passe par un membre. Ce rôle n'existe que dans le groupe ; seul à seul avec Yoan, le même bot agit librement.
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

**Réponse immédiate** :
Un message de Yoan envoyé pendant une discussion, adressé à un bot qui n'écrit pas à ce moment-là : ce bot répond tout de suite, en parallèle de la discussion, qui continue. Vaut aussi pour le meneur, cité ou non : un message sans citation s'adresse au meneur, qui peut y lancer une table ronde. Une réponse immédiate ne cite aucun bot ; si la discussion revient vers ce bot entre-temps, son tour attend la fin de sa réponse.
_Éviter_ : voie rapide, side, coulisse

**Recadrage** :
Un message de Yoan, ou du meneur, adressé à un bot pendant qu'il écrit, en groupe comme dans la conversation d'un bot seul : le bot le prend tout de suite dans son tour en cours, garde ce qu'il a déjà fait, et la discussion continue. En groupe, le bot visé est celui que Yoan cite, ou le meneur sans citation, y compris un bot qui travaille en coulisse dans une table ronde ; s'il ne travaille pas, c'est une réponse immédiate. Le meneur recadre seulement les membres de son groupe, au plus une fois par tour du membre, et seulement un membre qui travaille ; son recadrage apparaît dans le fil du groupe. Un membre ne recadre personne. Si son tour finit avant qu'il l'ait lu, il reprend aussitôt la parole avec, avant tout autre bot, résultat ou tâche automatique.
_Éviter_ : steer, guidage, message en attente

**Demande suivante** :
Un message que Yoan met de côté avec /q (ou /queue) pendant qu'un bot écrit ou qu'une discussion est en cours : il part de lui-même quand c'est fini et ouvre sa propre discussion. En groupe, « fini » veut dire la discussion terminée et toutes ses tables rondes rendues ; un arrêt de Yoan compte comme fini. Plusieurs demandes suivantes partent une par une, dans l'ordre. Yoan peut en annuler une tant qu'elle n'est pas partie. Quand rien n'est en cours, elle part tout de suite.
_Éviter_ : file, queue, message en file, message en attente

**Carte** :
Un élément visuel qu'un bot met dans sa réponse et que l'app dessine (récap, tableau, liste cochée, boutons...), à la place d'un long texte.
_Éviter_ : bloc, widget, bots-ui (sauf pour parler du format)

**Carte illisible** :
Une carte que le bot a mal écrite et que l'app ne peut pas dessiner. Son contenu est remis en texte, et l'original reste consultable sous « voir le brut » : rien n'est perdu.
_Éviter_ : bloc illisible, bloc invalide

**Accueil** :
L'écran d'entrée de l'app : les bots et groupes épinglés en grand en haut, puis tous les autres, bots et groupes mêlés, du plus récemment actif au plus ancien, chacun avec l'aperçu de son dernier message.
_Éviter_ : roster, liste des bots, home

**Ligne d'action** :
Une action d'un bot (commande, recherche, fichier, outil) résumée en une ligne cochée dans le fil, par exemple « ✓ Cherché sur le web : vols Montpellier ». Le détail s'ouvre au toucher.
_Éviter_ : carte d'outil, tool call, trace

**Statut du bot** :
Ce que fait un bot pendant son tour, dit en un mot sous son dernier message (« Réfléchit », « Cherche », « Écrit ») avec son personnage animé. Il disparaît à la fin du tour.
_Éviter_ : busy, indicateur de frappe, spinner

**Demande d'accord** :
Une carte « Besoin de ton OK » : le bot attend que Yoan accepte ou refuse une action avant de la faire. Deux boutons, le détail au toucher.
_Éviter_ : approval, validation de commande, popup
