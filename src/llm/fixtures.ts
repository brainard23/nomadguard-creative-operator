// Canned planning output used by FakeLlmClient (`--llm fake`) and the feature tests.

export const DEFAULT_FIXTURES: Record<string, unknown> = {
  strategy: {
    angles: [
      {
        name: "The Calm in the Chaos",
        target_emotion: "relief",
        hook: "Departure board flips to CANCELLED. Everyone panics. She doesn't blink.",
        concept:
          "While the terminal erupts around her, a composed traveler taps her phone: NomadGuard has already rebooked her and covered the hotel.",
        cta: "Travel protected. Get NomadGuard.",
      },
      {
        name: "Your Money, Back in the Air",
        target_emotion: "security",
        hook: "A boarding pass tears in slow motion.",
        concept:
          "Cost of a disrupted trip shown as vanishing cash, then NomadGuard reverses it: money flows back into her wallet.",
        cta: "Never pay for a delay again.",
      },
      {
        name: "Always On Time, Even When Flights Aren't",
        target_emotion: "confidence",
        hook: "She's the only calm face at a crowded gate.",
        concept:
          "A confident montage of a frequent traveler unfazed by disruption because her plan keeps moving.",
        cta: "Go anywhere. Be covered everywhere.",
      },
    ],
    selection: {
      selected_angle: "The Calm in the Chaos",
      why_selected:
        "It dramatizes the exact pain point in the first two seconds and resolves it with an unmistakable visual contrast.",
      audience_insight:
        "Frequent travelers do not fear the delay itself; they fear the scramble and the unplanned cost that follows.",
      why_it_performs:
        "A single striking visual contrast stops the scroll, needs no sound to understand, and ends on a clear emotional payoff.",
    },
  },
  storyboard: {
    style_guide: {
      character:
        "a woman in her early thirties with shoulder-length dark brown hair and a calm, confident expression",
      wardrobe: "a tailored camel wool coat over a white crew-neck tee, small leather carry-on",
      setting: "a modern glass-walled international airport terminal at golden hour",
      palette: "warm amber, deep navy and soft white",
      lens: "35mm anamorphic with shallow depth of field",
      grade: "premium cinematic teal-and-orange grade with gentle film grain",
      lighting: "low golden sun through terminal windows with soft rim light",
    },
    scenes: [
      {
        id: "s1",
        duration: 4,
        description:
          "The departure board flickers to red while a crowd of travelers reacts in frustration; she stands still in the middle of the frame, unbothered.",
        camera: "wide shot, slow push-in toward her",
        purpose: "hook",
        dialogue_or_sfx: "terminal announcement chime, murmur of the crowd",
      },
      {
        id: "s2",
        duration: 4,
        description:
          "Crowds rush toward the service desk behind her while she calmly looks down at her phone, a soft reassuring notification lighting her face.",
        camera: "medium close-up, handheld, rack focus from crowd to her face",
        purpose: "problem",
        dialogue_or_sfx: "crowd noise fades, a soft confirmation tone",
      },
      {
        id: "s3",
        duration: 4,
        description:
          "She smiles, slides the phone into her coat pocket and walks out of frame toward a new gate as the chaos blurs behind her.",
        camera: "tracking shot from the side, shallow depth of field",
        purpose: "resolution",
        dialogue_or_sfx: "warm ambient swell",
      },
    ],
    end_card: { duration: 2, headline: "Travel with confidence.", cta: "Get NomadGuard" },
  },
  creative_qa: {
    scores: {
      realism: { score: 8, note: "Photoreal terminal, natural lighting and believable crowd." },
      visual_consistency: { score: 8, note: "Same woman, coat and terminal across scenes." },
      brief_adherence: { score: 8, note: "Shows the disruption problem and the calm resolution." },
      hook_strength: { score: 8, note: "The red departure board reads instantly in the first second." },
      advertising_quality: { score: 8, note: "Polished cinematic look with a clear payoff." },
    },
    weakest_scene_id: "s2",
    issues: [],
    verdict_summary: "Offline fixture: a coherent, polished ad with no visible artifacts.",
  },
};
