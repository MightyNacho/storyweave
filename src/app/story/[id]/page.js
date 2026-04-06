import StoryApp from "@/app/components/StoryApp";

export default async function StoryPage({ params }) {
  const { id } = await params;
  return <StoryApp storyId={id} />;
}
