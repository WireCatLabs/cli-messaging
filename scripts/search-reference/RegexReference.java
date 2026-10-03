import java.nio.file.*;
import java.util.*;
import org.apache.lucene.util.automaton.*;
public class RegexReference {
  static String json(String s) { return "\""+s.replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n").replace("\r","\\r").replace("\t","\\t")+"\""; }
  public static void main(String[] args) throws Exception {
    String[] values={"","alpha","beta","a","aa","b","ab","abc","123","d","a1","_","α","😀"," ","\t","\n","a/b","a.b","*","^a$","aaaaab","A"};
    System.out.println("["); boolean first=true;
    for (String pattern:Files.readAllLines(Path.of(args[0]))) {
      if(!first)System.out.println(",");first=false;
      try {
        var matcher=new CharacterRunAutomaton(new RegExp(pattern,RegExp.ALL).toAutomaton());
        var matches=new ArrayList<String>();
        for(var value:values) if(matcher.run(value)) matches.add(json(value));
        System.out.print("{\"pattern\":"+json(pattern)+",\"parsed\":true,\"matches\":["+String.join(",",matches)+"]}");
      } catch(Exception e) {System.out.print("{\"pattern\":"+json(pattern)+",\"parsed\":false}");}
    }
    System.out.println("\n]");
  }
}
